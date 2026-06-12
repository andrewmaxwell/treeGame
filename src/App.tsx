import { useState, useRef, useCallback, useEffect, type RefObject } from 'react'
import { GameCanvas, type GameCanvasHandle } from './game/GameCanvas'
import { HUD, type ForecastDisplay } from './ui/HUD'
import { SeasonSummary } from './ui/SeasonSummary'
import { createInitialState, type GameState, type Season } from './game/state'
import {
  createPlanningState,
  handleTap,
  applySeasonAdvance,
  computeReachable,
  bankedEnergy,
  type PlanningState,
  type PlacementMode,
} from './game/planning'
import { buildSeasonSummary, type SeasonSummaryData } from './game/summary'
import {
  generateWeather,
  weatherHeadline,
  nextSeasonYear,
  seasonTrend,
  SEASON_MONTHS,
  type SeasonWeather,
} from './sim/weather'
import { simulateSeason, mulberry32 } from './sim/simulate'
import './App.css'

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter',
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

const TICKS_PER_SECOND = 12
const MS_PER_TICK = 1000 / TICKS_PER_SECOND

export function App() {
  // These refs are read by the canvas render loop — no React re-render on change
  const gameRef    = useRef<GameState>(createInitialState())
  const planningRef = useRef<PlanningState>(createPlanningState(bankedEnergy(gameRef.current.cells)))
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

  // Captured at advance time so finishPlayback can diff committed→final for the
  // season summary (the final state isn't known until playback completes/skips).
  const summaryInputRef = useRef<{ committed: GameState; weather: SeasonWeather } | null>(null)

  // Keep a ref to mode so the tap handler always sees the current value
  const modeRef = useRef<PlacementMode>('branch')
  useEffect(() => { modeRef.current = mode }, [mode])

  // ── playback machinery ────────────────────────────────────────────────────
  const playbackRef = useRef<{
    frames: GameState[]
    frameIdx: number
    lastTime: number
    rafId: number
  } | null>(null)

  const finishPlayback = useCallback((finalState: GameState) => {
    const pb = playbackRef.current
    if (pb) cancelAnimationFrame(pb.rafId)
    playbackRef.current = null

    // Advance the RNG seed for the next season by drawing one more value
    const rng = mulberry32(finalState.rngSeed)
    const nextSeed = Math.floor(rng() * 0xFFFFFFFF)

    gameRef.current = { ...finalState, rngSeed: nextSeed }

    // Planning budget = total banked energy across all living (non-deadwood) cells.
    // A productive summer with a big healthy canopy yields a big budget; a tree that
    // barely survived winter has almost nothing to spend.
    const newPlanning = createPlanningState(bankedEnergy(finalState.cells))
    planningRef.current = newPlanning

    // Build the season summary by diffing the committed (pre-sim) state against the
    // final state, using the weather captured at advance time.
    const si = summaryInputRef.current
    if (si) {
      setSummary(buildSeasonSummary(si.committed, finalState, si.weather))
      summaryInputRef.current = null
    }

    setSeasonYear({ season: finalState.season, year: finalState.year })
    setForecast(makeForecast(gameRef.current))
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

    const elapsed = now - pb.lastTime
    const steps = Math.floor(elapsed / MS_PER_TICK)
    if (steps > 0) {
      pb.lastTime += steps * MS_PER_TICK
      pb.frameIdx = Math.min(pb.frameIdx + steps, pb.frames.length - 1)
      gameRef.current = pb.frames[pb.frameIdx]
      canvasRef.current?.requestDraw()
      setProgress(pb.frameIdx / (pb.frames.length - 1))

      if (pb.frameIdx >= pb.frames.length - 1) {
        finishPlayback(pb.frames[pb.frames.length - 1])
        return
      }
    }

    pb.rafId = requestAnimationFrame(advancePlayback)
  }, [finishPlayback])

  const startPlayback = useCallback((frames: GameState[]) => {
    const pb = { frames, frameIdx: 0, lastTime: performance.now(), rafId: 0 }
    playbackRef.current = pb
    gameRef.current = frames[0]
    canvasRef.current?.requestDraw()
    setIsPlaying(true)
    setProgress(0)
    pb.rafId = requestAnimationFrame(advancePlayback)
  }, [advancePlayback])

  const onSkip = useCallback(() => {
    const pb = playbackRef.current
    if (!pb) return
    finishPlayback(pb.frames[pb.frames.length - 1])
  }, [finishPlayback])

  // ── planning callbacks ────────────────────────────────────────────────────
  const syncDisplay = useCallback((p: PlanningState) => {
    setEnergy(p.energyAvailable - p.energySpent)
    const reachable = computeReachable(p.stagedCells, gameRef.current)
    setCanAdvance(reachable.size === p.stagedCells.size)
  }, [])

  const onTap = useCallback((q: number, r: number) => {
    if (isPlaying) return
    const result = handleTap(q, r, modeRef.current, gameRef.current, planningRef.current)

    if (result.kind === 'rejected_rock' || result.kind === 'rejected_energy' || result.kind === 'rejected_adjacent') {
      canvasRef.current?.triggerShake()
      return
    }
    if (result.kind === 'noop') return

    planningRef.current = result.planning!
    syncDisplay(result.planning!)
    canvasRef.current?.requestDraw()
  }, [isPlaying, syncDisplay])

  const onAdvanceSeason = useCallback(() => {
    if (isPlaying) return

    // 0. Weather for the season being PLANNED (before the label advances). This is
    //    the single source of season truth for the simulation, so it stays correct
    //    even though applySeasonAdvance rolls the label forward to the next season.
    const cur = gameRef.current
    const weather = generateWeather(cur.season, cur.year, cur.worldSeed)

    // 1. Commit staged cells → new game state (label advanced to the next season)
    const committed = applySeasonAdvance(cur, planningRef.current)
    summaryInputRef.current = { committed, weather }

    // 2. Run simulation under the planned season's weather
    const rng = mulberry32(committed.rngSeed)
    const frames = simulateSeason(committed, rng, weather)

    // 3. Animate
    startPlayback(frames)
  }, [isPlaying, startPlayback])

  const onModeChange = useCallback((m: PlacementMode) => {
    setMode(m)
    modeRef.current = m
    canvasRef.current?.requestDraw()
  }, [])

  return (
    <div className="app-root">
      <GameCanvas
        ref={canvasRef}
        gameRef={gameRef as RefObject<GameState>}
        planningRef={planningRef as RefObject<PlanningState>}
        modeRef={modeRef as RefObject<PlacementMode>}
        isPlaying={isPlaying}
        onTap={onTap}
      />
      <HUD
        energyRemaining={energyRemaining}
        energyTotal={energyTotal}
        season={seasonYear.season}
        year={seasonYear.year}
        forecast={forecast}
        mode={mode}
        canAdvance={canAdvance}
        isPlaying={isPlaying}
        playbackProgress={playbackProgress}
        onModeChange={onModeChange}
        onAdvanceSeason={onAdvanceSeason}
        onSkip={onSkip}
      />
      {summary && <SeasonSummary data={summary} onDismiss={() => setSummary(null)} />}
    </div>
  )
}
