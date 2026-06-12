import { useState, useRef, useCallback, useEffect, type RefObject } from 'react'
import { GameCanvas, type GameCanvasHandle } from './game/GameCanvas'
import { HUD, type ForecastDisplay } from './ui/HUD'
import { SeasonSummary } from './ui/SeasonSummary'
import { Inspector } from './ui/Inspector'
import { GoalLog } from './ui/GoalLog'
import { createInitialState, type GameState, type Season } from './game/state'
import {
  createPlanningState,
  handleTap,
  applySeasonAdvance,
  resolvableShedKeys,
  computeReachable,
  bankedEnergy,
  CELL_COST,
  SPRING_VIGOR,
  type PlanningState,
  type PlacementMode,
} from './game/planning'
import { buildSeasonSummary, type SeasonSummaryData } from './game/summary'
import { evaluateGoals, currentGoal, completedMilestones, type GoalContext } from './game/goals'
import { computeRemovalSet, pruneCost, seversWholeCanopy } from './game/prune'
import { loadGame, saveGame, clearSave } from './game/save'
import { LEAF_SHED_RESORB } from './sim/cells'
import { Intro } from './ui/Intro'
import {
  generateWeather,
  weatherHeadline,
  nextSeasonYear,
  seasonTrend,
  SEASON_MONTHS,
  type SeasonWeather,
} from './sim/weather'
import { runSeason, mulberry32, type StormBreak } from './sim/simulate'
import { computeStructure } from './sim/structure'
import { hexKey } from './sim/grid'
import type { Cell } from './sim/cells'
import './App.css'

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter',
}

const EMPTY_PRUNE = new Set<string>()

// The cell currently shown in the inspector, snapshotted with its prune preview.
interface InspectState {
  key: string
  cell: Cell
  pruneSet: Set<string>
  cost: number
  severs: boolean
  stress?: number   // structural stress for wood cells (undefined for terminals/terrain)
}

// Build the HUD's forecast block for the season the player is currently planning.
function makeForecast(game: GameState): ForecastDisplay {
  const here = generateWeather(game.season, game.year, game.worldSeed)
  const now = weatherHeadline(here)

  const next = nextSeasonYear(game.season, game.year)
  const nextHeadline = weatherHeadline(generateWeather(next.season, next.year, game.worldSeed))

  // Two seasons out is only a vague trend (CLAUDE.md forecasting rules).
  const twoOut = nextSeasonYear(next.season, next.year)

  return {
    monthRange: SEASON_MONTHS[game.season],
    weatherIcon: now.icon,
    weatherLabel: now.label,
    nextSeasonLabel: SEASON_LABEL[next.season],
    nextForecast: `${nextHeadline.label} · then ${seasonTrend(twoOut.season)}`,
  }
}

interface GoalsView { current: string | null; completedCount: number }
function goalsViewOf(game: GameState): GoalsView {
  return { current: currentGoal(game.goals)?.goal ?? null, completedCount: game.goals.completed.length }
}

function countLiving(cells: Map<string, Cell>): number {
  let n = 0
  for (const c of cells.values()) {
    if (c.type === 'tree' || c.type === 'leaf' || c.type === 'flower' || c.type === 'fruit') n++
  }
  return n
}

const TICKS_PER_SECOND = 12
const MS_PER_TICK = 1000 / TICKS_PER_SECOND
// Playback holds this long when a storm snaps cells, so the break registers.
const STORM_PAUSE_MS = 900

export function App() {
  // Resume a saved run if one exists, else start fresh. The useState lazy initializer
  // ensures localStorage is read exactly once.
  const [initialGame] = useState<GameState>(() => loadGame() ?? createInitialState())

  // These refs are read by the canvas render loop — no React re-render on change
  const gameRef    = useRef<GameState>(initialGame)
  const planningRef = useRef<PlanningState>(createPlanningState(bankedEnergy(initialGame.cells)))
  const canvasRef  = useRef<GameCanvasHandle>(null)

  // React state — drives HUD display only
  const [mode, setMode]                = useState<PlacementMode>('branch')
  const [energyRemaining, setEnergy]   = useState(() => planningRef.current.energyAvailable)
  const [energyTotal, setEnergyTotal]  = useState(() => planningRef.current.energyAvailable)
  const [canAdvance, setCanAdvance]    = useState(true)
  const [seasonYear, setSeasonYear]    = useState({ season: gameRef.current.season, year: gameRef.current.year })
  const [isPlaying, setIsPlaying]      = useState(false)
  const [playbackProgress, setProgress] = useState(0)
  const [forecast, setForecast]        = useState<ForecastDisplay>(() => makeForecast(gameRef.current))
  const [summary, setSummary]          = useState<SeasonSummaryData | null>(null)
  const [score, setScore]              = useState(() => gameRef.current.score)
  const [goalsView, setGoalsView]      = useState<GoalsView>(() => goalsViewOf(gameRef.current))
  const [goalLogOpen, setGoalLogOpen]  = useState(false)
  const [inspected, setInspected]      = useState<InspectState | null>(null)
  const [stormFlash, setStormFlash]    = useState<string | null>(null)
  const [shedInfo, setShedInfo]        = useState<{ count: number; energy: number } | null>(null)
  const [showIntro, setShowIntro]      = useState(() => {
    try { return localStorage.getItem('treegame.introSeen') == null } catch { return false }
  })

  // Captured at advance time so finishPlayback can diff committed→final for the
  // season summary and evaluate goals once the final state is known.
  const summaryInputRef = useRef<{
    committed: GameState; weather: SeasonWeather; shedThisTurn: boolean; storms: StormBreak[]
  } | null>(null)

  // Keep a ref to mode so the tap handler always sees the current value
  const modeRef = useRef<PlacementMode>('branch')
  useEffect(() => { modeRef.current = mode }, [mode])

  // ── playback machinery ────────────────────────────────────────────────────
  const playbackRef = useRef<{
    frames: GameState[]
    frameIdx: number
    lastTime: number
    rafId: number
    storms: StormBreak[]
    nextStorm: number     // index of the next storm break not yet highlighted
    pauseUntil: number    // performance.now() deadline; playback holds for a beat on a break
  } | null>(null)

  const finishPlayback = useCallback((finalState: GameState) => {
    const pb = playbackRef.current
    if (pb) cancelAnimationFrame(pb.rafId)
    playbackRef.current = null

    // Advance the RNG seed for the next season by drawing one more value
    const rng = mulberry32(finalState.rngSeed)
    const nextSeed = Math.floor(rng() * 0xFFFFFFFF)

    // Evaluate milestones against the just-simulated season.
    const si = summaryInputRef.current
    const livingCells = countLiving(finalState.cells)
    let newlyCompletedLogs: string[] = []
    let nextGoals = finalState.goals
    if (si) {
      const stormCellsLost = si.storms.reduce((a, s) => a + s.cellsLost, 0)
      const ctx: GoalContext = {
        cells: finalState.cells,
        livingCells,
        peakCells: Math.max(finalState.goals.peakCells, livingCells),
        seasonSimulated: si.weather.season,
        yearSimulated: si.weather.year,
        shedThisTurn: si.shedThisTurn,
        score: finalState.score,
        droughtThisSeason: si.weather.isDrought,
        stormThisSeason: si.weather.storm != null,
        stormCellsLost,
      }
      const result = evaluateGoals(finalState.goals, ctx)
      nextGoals = result.progress
      newlyCompletedLogs = result.newlyCompleted.map((m) => `🏅 ${m.log}`)
    }

    gameRef.current = { ...finalState, rngSeed: nextSeed, goals: nextGoals }

    // Planning budget = total banked energy across all living (non-deadwood) cells,
    // floored in spring by the tree's vigor so a starved tree can always re-leaf.
    const banked = bankedEnergy(finalState.cells)
    const budget = finalState.season === 'spring' ? Math.max(banked, SPRING_VIGOR) : banked
    const newPlanning = createPlanningState(budget)
    planningRef.current = newPlanning

    // Build the season summary, appending the storm outcome and milestone celebrations.
    if (si) {
      const sum = buildSeasonSummary(si.committed, finalState, si.weather)
      if (si.weather.storm) {
        const lost = si.storms.reduce((a, s) => a + s.cellsLost, 0)
        sum.events.push(
          lost > 0
            ? `⛈️ A storm tore through — ${lost} ${lost === 1 ? 'cell' : 'cells'} lost.`
            : '⛈️ A storm blew through, but your tree held firm.',
        )
      }
      sum.events.push(...newlyCompletedLogs)
      setSummary(sum)
      summaryInputRef.current = null
    }

    setStormFlash(null)

    // Autosave the new planning-phase state.
    saveGame(gameRef.current)

    setSeasonYear({ season: finalState.season, year: finalState.year })
    setForecast(makeForecast(gameRef.current))
    setScore(gameRef.current.score)
    setGoalsView(goalsViewOf(gameRef.current))
    setInspected(null)
    setShedInfo(null)
    setEnergy(newPlanning.energyAvailable)
    setEnergyTotal(newPlanning.energyAvailable)
    setCanAdvance(true)
    setIsPlaying(false)
    setProgress(0)
    canvasRef.current?.requestDraw()
  }, [])

  const advancePlayback = useCallback((now: DOMHighResTimeStamp) => {
    const pb = playbackRef.current
    if (!pb) return

    // Holding for a beat after a storm break so the player registers the damage.
    if (now < pb.pauseUntil) {
      pb.lastTime = now  // don't let the clock accumulate steps during the pause
      pb.rafId = requestAnimationFrame(advancePlayback)
      return
    }

    const elapsed = now - pb.lastTime
    const steps = Math.floor(elapsed / MS_PER_TICK)
    if (steps > 0) {
      pb.lastTime += steps * MS_PER_TICK
      pb.frameIdx = Math.min(pb.frameIdx + steps, pb.frames.length - 1)
      gameRef.current = pb.frames[pb.frameIdx]
      canvasRef.current?.requestDraw()
      setProgress(pb.frameIdx / (pb.frames.length - 1))

      // Highlight any storm break we just reached: shake, flash, and pause a beat.
      let paused = false
      while (pb.nextStorm < pb.storms.length && pb.frameIdx >= pb.storms[pb.nextStorm].frame) {
        const st = pb.storms[pb.nextStorm++]
        canvasRef.current?.triggerShake()
        setStormFlash(`⛈️ A storm snapped ${st.cellsLost} ${st.cellsLost === 1 ? 'cell' : 'cells'}!`)
        pb.pauseUntil = now + STORM_PAUSE_MS
        paused = true
      }

      if (!paused && pb.frameIdx >= pb.frames.length - 1) {
        finishPlayback(pb.frames[pb.frames.length - 1])
        return
      }
    }

    pb.rafId = requestAnimationFrame(advancePlayback)
  }, [finishPlayback])

  const startPlayback = useCallback((frames: GameState[], storms: StormBreak[]) => {
    const pb = {
      frames, frameIdx: 0, lastTime: performance.now(), rafId: 0,
      storms, nextStorm: 0, pauseUntil: 0,
    }
    playbackRef.current = pb
    gameRef.current = frames[0]
    canvasRef.current?.requestDraw()
    setStormFlash(null)
    setIsPlaying(true)
    setProgress(0)
    pb.rafId = requestAnimationFrame(advancePlayback)
  }, [advancePlayback])

  const onSkip = useCallback(() => {
    const pb = playbackRef.current
    if (!pb) return
    setStormFlash(null)
    finishPlayback(pb.frames[pb.frames.length - 1])
  }, [finishPlayback])

  // ── planning callbacks ────────────────────────────────────────────────────
  const syncDisplay = useCallback((p: PlanningState) => {
    setEnergy(p.energyAvailable - p.energySpent)
    const reachable = computeReachable(p.stagedCells, gameRef.current)
    setCanAdvance(reachable.size === p.stagedCells.size)
    // Estimated energy resorbed from leaves marked to shed this fall — surfaced so the
    // player can see shedding is worth more than letting winter frost take them.
    const shedKeys = resolvableShedKeys(gameRef.current, p)
    let e = 0
    for (const k of shedKeys) e += gameRef.current.cells.get(k)?.energy ?? 0
    setShedInfo(shedKeys.size > 0 ? { count: shedKeys.size, energy: e * LEAF_SHED_RESORB } : null)
  }, [])

  const onTap = useCallback((q: number, r: number) => {
    if (isPlaying) return
    const result = handleTap(q, r, modeRef.current, gameRef.current, planningRef.current)

    if (result.kind === 'rejected_rock' || result.kind === 'rejected_energy' || result.kind === 'rejected_adjacent') {
      canvasRef.current?.triggerShake()
      return
    }

    if (result.kind === 'inspect') {
      const key = hexKey(q, r)
      const cell = gameRef.current.cells.get(key)
      if (!cell) return
      const set = computeRemovalSet(gameRef.current.cells, key)
      const stress = computeStructure(gameRef.current.cells).stress.get(key)
      setInspected({ key, cell, pruneSet: set, cost: pruneCost(cell), severs: seversWholeCanopy(gameRef.current.cells, set), stress })
      canvasRef.current?.requestDraw()
      return
    }

    if (result.kind === 'noop') { setInspected(null); return }

    // A placement/unstage/shed action — close any open inspector and sync.
    setInspected(null)
    planningRef.current = result.planning!
    syncDisplay(result.planning!)
    canvasRef.current?.requestDraw()
  }, [isPlaying, syncDisplay])

  const onPrune = useCallback(() => {
    if (!inspected) return
    const { pruneSet, cost } = inspected

    // Remove the doomed cells immediately.
    const newCells = new Map(gameRef.current.cells)
    for (const k of pruneSet) newCells.delete(k)
    gameRef.current = { ...gameRef.current, cells: newCells }

    // Any staged growth now severed from the tree auto-unstages with a refund.
    const pl = planningRef.current
    const reachable = computeReachable(pl.stagedCells, gameRef.current)
    const newStaged = new Map(pl.stagedCells)
    let refund = 0
    for (const k of [...newStaged.keys()]) {
      if (!reachable.has(k)) { newStaged.delete(k); refund += CELL_COST }
    }
    planningRef.current = {
      ...pl,
      stagedCells: newStaged,
      pruneCostAccrued: pl.pruneCostAccrued + cost,
      energySpent: pl.energySpent + cost - refund,
    }

    setInspected(null)
    syncDisplay(planningRef.current)
    canvasRef.current?.requestDraw()
  }, [inspected, syncDisplay])

  const onAdvanceSeason = useCallback(() => {
    if (isPlaying) return
    setInspected(null)

    // 0. Weather for the season being PLANNED (before the label advances). This is
    //    the single source of season truth for the simulation, so it stays correct
    //    even though applySeasonAdvance rolls the label forward to the next season.
    const cur = gameRef.current
    const weather = generateWeather(cur.season, cur.year, cur.worldSeed)
    const shedKeys = resolvableShedKeys(cur, planningRef.current)
    const shedThisTurn = shedKeys.size > 0

    // 1. Commit staged cells → new game state (label advanced to the next season)
    const committed = applySeasonAdvance(cur, planningRef.current)

    // 2. Run simulation under the planned season's weather; shed leaves resorb + drop
    //    at season end (after photosynthesizing all season). Storm breaks come back
    //    alongside the frames for the playback highlight + summary.
    const rng = mulberry32(committed.rngSeed)
    const { frames, storms } = runSeason(committed, rng, weather, shedKeys)
    summaryInputRef.current = { committed, weather, shedThisTurn, storms }

    // 3. Animate
    startPlayback(frames, storms)
  }, [isPlaying, startPlayback])

  const onModeChange = useCallback((m: PlacementMode) => {
    setMode(m)
    modeRef.current = m
    canvasRef.current?.requestDraw()
  }, [])

  // Plant a new seed: clear the save and reset every bit of run state. Guarded by a
  // confirm because it discards the current tree.
  const onNewGame = useCallback(() => {
    if (!window.confirm('Plant a new seed? This ends your current tree and starts over.')) return
    // Stop any in-flight playback.
    const pb = playbackRef.current
    if (pb) cancelAnimationFrame(pb.rafId)
    playbackRef.current = null

    clearSave()
    const fresh = createInitialState()
    gameRef.current = fresh
    const planning = createPlanningState(bankedEnergy(fresh.cells))
    planningRef.current = planning
    summaryInputRef.current = null

    setMode('branch'); modeRef.current = 'branch'
    setEnergy(planning.energyAvailable)
    setEnergyTotal(planning.energyAvailable)
    setCanAdvance(true)
    setSeasonYear({ season: fresh.season, year: fresh.year })
    setIsPlaying(false)
    setProgress(0)
    setForecast(makeForecast(fresh))
    setSummary(null)
    setScore(fresh.score)
    setGoalsView(goalsViewOf(fresh))
    setInspected(null)
    setStormFlash(null)
    setShedInfo(null)
    canvasRef.current?.recenter()
    canvasRef.current?.requestDraw()
  }, [])

  const onHelp = useCallback(() => setShowIntro(true), [])
  const onDismissIntro = useCallback(() => {
    setShowIntro(false)
    try { localStorage.setItem('treegame.introSeen', '1') } catch { /* ignore */ }
  }, [])

  // Spring with a bare canopy: the leaves are gone (deciduous) and the player needs
  // to grow new ones to restart photosynthesis. This is the single most confusing
  // moment for new players, so call it out explicitly.
  const planningSeason = seasonYear.season
  let leafCount = 0, woodCount = 0
  for (const c of gameRef.current.cells.values()) {
    if (c.type === 'leaf') leafCount++
    else if (c.type === 'tree') woodCount++
  }
  const leafless = leafCount === 0
  // Only prompt to re-leaf if the tree has actually grown a leaf before (the first-leaf
  // milestone) — never on a brand-new seed that has simply never had leaves yet.
  const hasGrownLeavesBefore = gameRef.current.goals.completed.includes('first-leaf')
  const springReLeaf = !isPlaying && planningSeason === 'spring' && leafless && hasGrownLeavesBefore

  // Fall reserve warning: winter is dormant (no photosynthesis), so the tree survives
  // on banked energy alone — roughly woodCount × 0.3 to last the season, plus a margin
  // to re-leaf in spring. If you've drawn your reserves below that, you're spending
  // toward a hungry winter. Teaches "bank energy before the cold" — only when at risk.
  const fallReserveHint =
    !isPlaying && planningSeason === 'fall' && energyRemaining < woodCount * 0.5

  // Gentle unspent-energy nudge: early years, growth seasons only (hoarding into
  // fall/winter is correct, so it's suppressed there). Suppressed when the more
  // specific spring re-leaf hint is showing.
  const showNudge =
    !isPlaying &&
    !springReLeaf &&
    seasonYear.year <= 4 &&
    planningSeason !== 'fall' &&
    planningSeason !== 'winter' &&
    energyTotal > 0 &&
    energyRemaining > 0.3 * energyTotal

  return (
    <div className="app-root">
      <GameCanvas
        ref={canvasRef}
        gameRef={gameRef as RefObject<GameState>}
        planningRef={planningRef as RefObject<PlanningState>}
        modeRef={modeRef as RefObject<PlacementMode>}
        isPlaying={isPlaying}
        inspectedKey={inspected?.key ?? null}
        pruneSet={inspected?.pruneSet ?? EMPTY_PRUNE}
        onTap={onTap}
      />
      <HUD
        energyRemaining={energyRemaining}
        energyTotal={energyTotal}
        season={seasonYear.season}
        year={seasonYear.year}
        score={score}
        forecast={forecast}
        currentGoal={goalsView.current}
        completedGoals={goalsView.completedCount}
        showNudge={showNudge}
        springReLeaf={springReLeaf}
        fallReserveHint={fallReserveHint}
        shedInfo={planningSeason === 'fall' ? shedInfo : null}
        mode={mode}
        canAdvance={canAdvance}
        isPlaying={isPlaying}
        playbackProgress={playbackProgress}
        onModeChange={onModeChange}
        onAdvanceSeason={onAdvanceSeason}
        onSkip={onSkip}
        onOpenGoals={() => setGoalLogOpen(true)}
        onNewGame={onNewGame}
        onHelp={onHelp}
      />
      {inspected && !isPlaying && (
        <Inspector
          cell={inspected.cell}
          removalCount={inspected.pruneSet.size}
          cost={inspected.cost}
          affordable={energyRemaining >= inspected.cost}
          seversCanopy={inspected.severs}
          stress={inspected.stress}
          onPrune={onPrune}
          onClose={() => setInspected(null)}
        />
      )}
      {stormFlash && <div className="storm-flash">{stormFlash}</div>}
      {showIntro && <Intro onDismiss={onDismissIntro} />}
      {goalLogOpen && (
        <GoalLog
          completed={completedMilestones(gameRef.current.goals)}
          currentGoalId={currentGoal(gameRef.current.goals)?.id ?? null}
          onClose={() => setGoalLogOpen(false)}
        />
      )}
      {summary && <SeasonSummary data={summary} onDismiss={() => setSummary(null)} />}
    </div>
  )
}
