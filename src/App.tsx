import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type RefObject,
} from "react";
import { GameCanvas, type GameCanvasHandle } from "./game/GameCanvas";
import { HUD, type ForecastDisplay } from "./ui/HUD";
import { SeasonSummary } from "./ui/SeasonSummary";
import { Inspector } from "./ui/Inspector";
import { GoalLog } from "./ui/GoalLog";
import { createInitialState, type GameState, type Season } from "./game/state";
import {
  createPlanningState,
  handleTap,
  applyPlanCommit,
  applySeasonAdvance,
  computeReachable,
  getValidPlacements,
  bankedEnergy,
  stagedCost,
  SPRING_VIGOR,
  type PlanningState,
  type PlacementMode,
} from "./game/planning";
import { buildSeasonSummary, type SeasonSummaryData } from "./game/summary";
import { diagnoseReport } from "./game/diagnose";
import {
  evaluateGoals,
  currentGoal,
  completedMilestones,
  type GoalContext,
} from "./game/goals";
import {
  computeRemovalSet,
  pruneCost,
  seversWholeCanopy,
  removesEntireTree,
  computeMultiRemoval,
  pruneSelectionCost,
  isPruneable,
} from "./game/prune";
import { loadGame, saveGame, clearSave } from "./game/save";
import { Intro } from "./ui/Intro";
import {
  generateWeather,
  weatherHeadline,
  nextSeasonYear,
  seasonTrend,
  seasonMeaning,
  SEASON_MONTHS,
  type SeasonWeather,
} from "./sim/weather";
import { runSeasonPart, mulberry32, type StormBreak } from "./sim/simulate";
import { computeStructure } from "./sim/structure";
import { hexKey } from "./sim/grid";
import type { Cell } from "./sim/cells";
import type { ResourceOverlay } from "./render/colors";
import "./App.css";

const SEASON_LABEL: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
  winter: "Winter",
};

const EMPTY_PRUNE = new Set<string>();

// The cell currently shown in the inspector, snapshotted with its prune preview.
interface InspectState {
  key: string;
  cell: Cell;
  pruneSet: Set<string>;
  cost: number;
  severs: boolean;
  removesAll: boolean; // pruning this would wipe out the whole tree → blocked
  stress?: number; // structural stress for wood cells (undefined for terminals/terrain)
}

// Build the HUD's forecast block for the season the player is currently planning.
function makeForecast(game: GameState): ForecastDisplay {
  const here = generateWeather(game.season, game.year, game.worldSeed);
  const now = weatherHeadline(here);

  const next = nextSeasonYear(game.season, game.year);
  const nextHeadline = weatherHeadline(
    generateWeather(next.season, next.year, game.worldSeed),
  );

  // Two seasons out is only a vague trend (CLAUDE.md forecasting rules).
  const twoOut = nextSeasonYear(next.season, next.year);

  return {
    monthRange: SEASON_MONTHS[game.season],
    weatherIcon: now.icon,
    weatherLabel: now.label,
    nextSeasonLabel: SEASON_LABEL[next.season],
    nextSeasonMeaning: seasonMeaning(next.season),
    nextForecast: `Forecast: ${nextHeadline.icon} ${nextHeadline.label} · then ${seasonTrend(twoOut.season)}`,
  };
}

interface GoalsView {
  current: string | null;
  completedCount: number;
}
function goalsViewOf(game: GameState): GoalsView {
  return {
    current: currentGoal(game.goals)?.goal ?? null,
    completedCount: game.goals.completed.length,
  };
}

function countLiving(cells: Map<string, Cell>): number {
  let n = 0;
  for (const c of cells.values()) {
    if (
      c.type === "tree" ||
      c.type === "reinforced wood" ||
      c.type === "leaf" ||
      c.type === "flower" ||
      c.type === "fruit"
    )
      n++;
  }
  return n;
}

function hasType(cells: Map<string, Cell>, type: Cell["type"]): boolean {
  for (const c of cells.values()) if (c.type === type) return true;
  return false;
}

// Total water + energy held across all living cells — shown live during playback so the
// player can watch photosynthesis fill energy and transpiration draw water.
function sumResources(cells: Map<string, Cell>): {
  water: number;
  energy: number;
} {
  let water = 0,
    energy = 0;
  for (const c of cells.values()) {
    if (
      c.type === "tree" ||
      c.type === "reinforced wood" ||
      c.type === "leaf" ||
      c.type === "flower" ||
      c.type === "fruit"
    ) {
      water += c.water;
      energy += c.energy;
    }
  }
  return { water, energy };
}

const TICKS_PER_SECOND = 12;
const MS_PER_TICK = 1000 / TICKS_PER_SECOND;
// Playback holds this long when a storm snaps cells, so the break registers.
const STORM_PAUSE_MS = 900;
// A season is simulated in two halves with a planning checkpoint between (M11). The two
// halves draw from independent RNG streams so a mid-season save replays identically; the
// second half's stream is the season seed mixed with this salt.
const HALF2_RNG_SALT = 0x9e3779b9;

export function App() {
  // Resume a saved run if one exists, else start fresh. The useState lazy initializer
  // ensures localStorage is read exactly once.
  const [initialGame] = useState<GameState>(
    () => loadGame() ?? createInitialState(),
  );

  // These refs are read by the canvas render loop — no React re-render on change
  const gameRef = useRef<GameState>(initialGame);
  const planningRef = useRef<PlanningState>(
    createPlanningState(bankedEnergy(initialGame.cells)),
  );
  const canvasRef = useRef<GameCanvasHandle>(null);

  // React state — drives HUD display only
  const [mode, setMode] = useState<PlacementMode>("branch");
  const [energyRemaining, setEnergy] = useState(
    () => planningRef.current.energyAvailable,
  );
  const [energyTotal, setEnergyTotal] = useState(
    () => planningRef.current.energyAvailable,
  );
  const [canAdvance, setCanAdvance] = useState(true);
  const [seasonYear, setSeasonYear] = useState({
    season: gameRef.current.season,
    year: gameRef.current.year,
    half: gameRef.current.seasonHalf,
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setProgress] = useState(0);
  const [forecast, setForecast] = useState<ForecastDisplay>(() =>
    makeForecast(gameRef.current),
  );
  const [summary, setSummary] = useState<SeasonSummaryData | null>(null);
  const [score, setScore] = useState(() => gameRef.current.score);
  const [goalsView, setGoalsView] = useState<GoalsView>(() =>
    goalsViewOf(gameRef.current),
  );
  const [goalLogOpen, setGoalLogOpen] = useState(false);
  const [inspected, setInspected] = useState<InspectState | null>(null);
  const [stormFlash, setStormFlash] = useState<string | null>(null);
  const [playStats, setPlayStats] = useState<{
    water: number;
    energy: number;
  } | null>(null);
  const [overlay, setOverlay] = useState<ResourceOverlay>("none");
  // Bulk "speed prune": a selection of cells to remove in one confirm (playtest request).
  const [pruneMode, setPruneMode] = useState(false);
  const [pruneSel, setPruneSel] = useState<Set<string>>(() => new Set());
  const [showIntro, setShowIntro] = useState(() => {
    try {
      return localStorage.getItem("treegame.introSeen") == null;
    } catch {
      return false;
    }
  });

  // Captured at advance time so finishPlayback can diff committed→final for the
  // season summary and evaluate goals once the final state is known.
  const summaryInputRef = useRef<{
    committed: GameState;
    weather: SeasonWeather;
    shedThisTurn: boolean;
    storms: StormBreak[];
    part: 0 | 1;
  } | null>(null);

  // Keep a ref to mode so the tap handler always sees the current value
  const modeRef = useRef<PlacementMode>("branch");
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Diagnostics: print a dense health report to the console on page load, and expose
  // `treegameDiagnose()` to re-run it any time (e.g. after playing a few seasons) — so
  // the run can be shared as copyable text rather than an un-readable screenshot.
  useEffect(() => {
    const run = () => console.log(diagnoseReport(gameRef.current));
    (window as unknown as { treegameDiagnose?: () => void }).treegameDiagnose =
      run;
    run();
  }, []);

  // ── playback machinery ────────────────────────────────────────────────────
  const playbackRef = useRef<{
    frames: GameState[];
    frameIdx: number;
    lastTime: number;
    rafId: number;
    storms: StormBreak[];
    nextStorm: number; // index of the next storm break not yet highlighted
    pauseUntil: number; // performance.now() deadline; playback holds for a beat on a break
    finishing: boolean; // reached the last frame; finish on the NEXT step so the canvas can
    // diff+animate that final transition (e.g. the autumn leaf-drop) while still "playing"
  } | null>(null);

  const finishPlayback = useCallback((finalState: GameState) => {
    const pb = playbackRef.current;
    if (pb) cancelAnimationFrame(pb.rafId);
    playbackRef.current = null;

    // A full season completes only at the end of part 1 (finalState back to half 0). Advance
    // the RNG seed for the next season then; after part 0 (the mid-season checkpoint) the seed
    // is held so part 1 derives its own independent stream from the same persisted seed.
    const seasonComplete = finalState.seasonHalf === 0;
    const nextSeed = seasonComplete
      ? Math.floor(mulberry32(finalState.rngSeed)() * 0xffffffff)
      : finalState.rngSeed;

    // Evaluate milestones against the just-simulated season.
    const si = summaryInputRef.current;
    const livingCells = countLiving(finalState.cells);
    let newlyCompletedLogs: string[] = [];
    let nextGoals = finalState.goals;
    if (si) {
      const stormCellsLost = si.storms.reduce((a, s) => a + s.cellsLost, 0);
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
        seedsThisSeason: Math.max(0, finalState.score - si.committed.score),
        grewFlowerThisTurn: hasType(si.committed.cells, "flower"),
      };
      const result = evaluateGoals(finalState.goals, ctx);
      nextGoals = result.progress;
      newlyCompletedLogs = result.newlyCompleted.map((m) => `🏅 ${m.log}`);
    }

    gameRef.current = { ...finalState, rngSeed: nextSeed, goals: nextGoals };

    // Planning budget = total banked energy across all living (non-deadwood) cells,
    // floored in spring by the tree's vigor so a starved tree can always re-leaf.
    const banked = bankedEnergy(finalState.cells);
    const budget =
      finalState.season === "spring" ? Math.max(banked, SPRING_VIGOR) : banked;
    const newPlanning = createPlanningState(budget);
    planningRef.current = newPlanning;

    // Build the season summary, appending the storm outcome and milestone celebrations.
    if (si) {
      const sum = buildSeasonSummary(si.committed, finalState, si.weather);
      if (si.weather.storm) {
        const lost = si.storms.reduce((a, s) => a + s.cellsLost, 0);
        sum.events.push(
          lost > 0
            ? `⛈️ A storm tore through — ${lost} ${lost === 1 ? "cell" : "cells"} lost.`
            : "⛈️ A storm blew through, but your tree held firm.",
        );
      }
      sum.events.push(...newlyCompletedLogs);
      setSummary(sum);
      summaryInputRef.current = null;
    }

    setStormFlash(null);

    // Autosave the new planning-phase state.
    saveGame(gameRef.current);

    // Flower mode is spring-only; leaving spring drops back to Wood so the toggle and
    // placement stay coherent. Reinforced mode is not seasonal so it persists.
    if (finalState.season !== "spring" && modeRef.current === "flower") {
      setMode("branch");
      modeRef.current = "branch";
    }

    setSeasonYear({
      season: finalState.season,
      year: finalState.year,
      half: finalState.seasonHalf,
    });
    setForecast(makeForecast(gameRef.current));
    setScore(gameRef.current.score);
    setGoalsView(goalsViewOf(gameRef.current));
    setInspected(null);
    setEnergy(newPlanning.energyAvailable);
    setEnergyTotal(newPlanning.energyAvailable);
    setCanAdvance(true);
    setIsPlaying(false);
    setProgress(0);
    setPlayStats(null);
    canvasRef.current?.setPlaying(false); // stop playback animations (pop/shimmer/leaf-fall)
    canvasRef.current?.requestDraw();
  }, []);

  const advancePlayback = useCallback(
    (now: DOMHighResTimeStamp) => {
      const pb = playbackRef.current;
      if (!pb) return;

      // Holding for a beat after a storm break so the player registers the damage.
      if (now < pb.pauseUntil) {
        pb.lastTime = now; // don't let the clock accumulate steps during the pause
        pb.rafId = requestAnimationFrame(advancePlayback);
        return;
      }

      const elapsed = now - pb.lastTime;
      const steps = Math.floor(elapsed / MS_PER_TICK);
      if (steps > 0) {
        pb.lastTime += steps * MS_PER_TICK;
        pb.frameIdx = Math.min(pb.frameIdx + steps, pb.frames.length - 1);
        gameRef.current = pb.frames[pb.frameIdx];
        canvasRef.current?.requestDraw();
        setProgress(pb.frameIdx / (pb.frames.length - 1));
        setPlayStats(sumResources(gameRef.current.cells));

        // Highlight any storm break we just reached: shake, flash, and pause a beat.
        let paused = false;
        while (
          pb.nextStorm < pb.storms.length &&
          pb.frameIdx >= pb.storms[pb.nextStorm].frame
        ) {
          const st = pb.storms[pb.nextStorm++];
          canvasRef.current?.triggerShake();
          setStormFlash(
            `⛈️ A storm snapped ${st.cellsLost} ${st.cellsLost === 1 ? "cell" : "cells"}!`,
          );
          pb.pauseUntil = now + STORM_PAUSE_MS;
          paused = true;
        }

        if (!paused && pb.frameIdx >= pb.frames.length - 1) {
          // The last frame carries the end-of-season resolution (autumn drop / fruit set),
          // so its transition is where leaves fall. Render it for one more step (with
          // playback still active) so the canvas diffs it and spawns the leaf-fall, THEN
          // finish — otherwise finishPlayback flips playback off before that diff runs.
          if (pb.finishing) {
            finishPlayback(pb.frames[pb.frames.length - 1]);
            return;
          }
          pb.finishing = true;
        }
      }

      pb.rafId = requestAnimationFrame(advancePlayback);
    },
    [finishPlayback],
  );

  const startPlayback = useCallback(
    (frames: GameState[], storms: StormBreak[]) => {
      const pb = {
        frames,
        frameIdx: 0,
        lastTime: performance.now(),
        rafId: 0,
        storms,
        nextStorm: 0,
        pauseUntil: 0,
        finishing: false,
      };
      playbackRef.current = pb;
      gameRef.current = frames[0];
      canvasRef.current?.setPlaying(true); // enable animations before the first frame draws
      canvasRef.current?.requestDraw();
      setStormFlash(null);
      setIsPlaying(true);
      setProgress(0);
      setPlayStats(sumResources(frames[0].cells));
      pb.rafId = requestAnimationFrame(advancePlayback);
    },
    [advancePlayback],
  );

  const onSkip = useCallback(() => {
    const pb = playbackRef.current;
    if (!pb) return;
    setStormFlash(null);
    finishPlayback(pb.frames[pb.frames.length - 1]);
  }, [finishPlayback]);

  // ── planning callbacks ────────────────────────────────────────────────────
  const syncDisplay = useCallback((p: PlanningState) => {
    setEnergy(p.energyAvailable - p.energySpent);
    const reachable = computeReachable(p.stagedCells, gameRef.current);
    setCanAdvance(reachable.size === p.stagedCells.size);
  }, []);

  const onTap = useCallback(
    (q: number, r: number) => {
      if (isPlaying) return;

      // Bulk-prune mode: tap toggles a pruneable cell in the prune selection. Leaves aren't
      // pruneable (auto-managed) — they drop free as collateral when their wood is cut.
      if (pruneMode) {
        const key = hexKey(q, r);
        const cell = gameRef.current.cells.get(key);
        if (!cell || !isPruneable(cell)) return;
        setPruneSel((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }

      const result = handleTap(
        q,
        r,
        modeRef.current,
        gameRef.current,
        planningRef.current,
      );

      if (
        result.kind === "rejected_rock" ||
        result.kind === "rejected_energy" ||
        result.kind === "rejected_adjacent" ||
        result.kind === "rejected_winter"
      ) {
        canvasRef.current?.triggerShake();
        return;
      }

      if (result.kind === "inspect") {
        const key = hexKey(q, r);
        const cell = gameRef.current.cells.get(key);
        if (!cell) return;
        const set = computeRemovalSet(gameRef.current.cells, key);
        const stress = computeStructure(gameRef.current.cells).stress.get(key);
        setInspected({
          key,
          cell,
          pruneSet: set,
          cost: pruneCost(cell),
          severs: seversWholeCanopy(gameRef.current.cells, set),
          removesAll: removesEntireTree(gameRef.current.cells, set),
          stress,
        });
        canvasRef.current?.requestDraw();
        return;
      }

      if (result.kind === "noop") {
        setInspected(null);
        return;
      }

      // A placement/unstage/shed action — close any open inspector and sync.
      setInspected(null);
      planningRef.current = result.planning!;
      syncDisplay(result.planning!);
      canvasRef.current?.requestDraw();
    },
    [isPlaying, pruneMode, syncDisplay],
  );

  const onPrune = useCallback(() => {
    if (!inspected || inspected.removesAll) return; // can't prune the whole tree away
    const { pruneSet, cost } = inspected;

    // Remove the doomed cells immediately.
    const newCells = new Map(gameRef.current.cells);
    for (const k of pruneSet) newCells.delete(k);
    gameRef.current = { ...gameRef.current, cells: newCells };

    // Any staged growth now severed from the tree auto-unstages with a refund.
    const pl = planningRef.current;
    const reachable = computeReachable(pl.stagedCells, gameRef.current);
    const newStaged = new Map(pl.stagedCells);
    let refund = 0;
    for (const k of [...newStaged.keys()]) {
      const sc = newStaged.get(k);
      if (sc && !reachable.has(k)) {
        refund += stagedCost(sc);
        newStaged.delete(k);
      }
    }
    planningRef.current = {
      ...pl,
      stagedCells: newStaged,
      pruneCostAccrued: pl.pruneCostAccrued + cost,
      energySpent: pl.energySpent + cost - refund,
    };

    setInspected(null);
    syncDisplay(planningRef.current);
    canvasRef.current?.requestDraw();
  }, [inspected, syncDisplay]);

  // Enter/leave bulk-prune mode. Entering clears any open inspector and prior selection.
  const onTogglePrune = useCallback(() => {
    setInspected(null);
    setPruneSel(new Set());
    setPruneMode((v) => !v);
    canvasRef.current?.requestDraw();
  }, []);

  // Confirm a bulk prune: remove the whole selection (+ everything it disconnects) in one
  // breakage pass, accrue the wound-sealing cost, and refund any staged growth it severs.
  const onConfirmPrune = useCallback(() => {
    const cells = gameRef.current.cells;
    const removal = computeMultiRemoval(cells, pruneSel);
    if (removal.size === 0) return;
    if (removesEntireTree(cells, removal)) return; // can't prune the whole tree away
    if (
      seversWholeCanopy(cells, removal) &&
      !window.confirm("This removes your whole canopy. Prune anyway?")
    )
      return;

    const cost = pruneSelectionCost(cells, pruneSel);
    const newCells = new Map(cells);
    for (const k of removal) newCells.delete(k);
    gameRef.current = { ...gameRef.current, cells: newCells };

    // Any staged growth now severed from the tree auto-unstages with a refund.
    const pl = planningRef.current;
    const reachable = computeReachable(pl.stagedCells, gameRef.current);
    const newStaged = new Map(pl.stagedCells);
    let refund = 0;
    for (const k of [...newStaged.keys()]) {
      const sc = newStaged.get(k);
      if (sc && !reachable.has(k)) {
        refund += stagedCost(sc);
        newStaged.delete(k);
      }
    }
    planningRef.current = {
      ...pl,
      stagedCells: newStaged,
      pruneCostAccrued: pl.pruneCostAccrued + cost,
      energySpent: pl.energySpent + cost - refund,
    };

    setPruneMode(false);
    setPruneSel(new Set());
    syncDisplay(planningRef.current);
    canvasRef.current?.requestDraw();
  }, [pruneSel, syncDisplay]);

  const onAdvanceSeason = useCallback(() => {
    if (isPlaying) return;
    setInspected(null);
    setPruneMode(false);
    setPruneSel(new Set());

    // 0. Weather for the season being PLANNED (before any label advance). This is the
    //    single source of season truth for the simulation, so it stays correct even though
    //    part 1's commit rolls the label forward to the next season.
    const cur = gameRef.current;
    const weather = generateWeather(cur.season, cur.year, cur.worldSeed);
    const part = cur.seasonHalf;
    // The whole canopy auto-drops at fall's end — that happens in part 1's end-of-season
    // resolution, which is the "shed" event the milestone tracks (now automatic).
    const shedThisTurn = cur.season === "fall" && part === 1;

    // 1. Commit the staged plan. Part 0 commits WITHOUT advancing the season (we stay in
    //    this season for the second half); part 1's commit advances the label to the next
    //    season and resets the half. Each half draws an independent RNG stream from the
    //    same persisted seed so a mid-season save replays identically.
    let committed: GameState;
    let rng: ReturnType<typeof mulberry32>;
    if (part === 0) {
      committed = {
        ...applyPlanCommit(cur, planningRef.current),
        seasonHalf: 1,
      };
      rng = mulberry32(committed.rngSeed);
    } else {
      committed = applySeasonAdvance(cur, planningRef.current);
      rng = mulberry32((committed.rngSeed ^ HALF2_RNG_SALT) >>> 0);
    }

    // 2. Simulate this half under the planned season's weather. Part 0 runs the first 30
    //    ticks (season-onset events fire here); part 1 runs the last 30 and resolves the
    //    end-of-season events (autumn drop / fruit set / aging).
    const { frames, storms } = runSeasonPart(committed, rng, weather, part);
    summaryInputRef.current = {
      committed,
      weather,
      shedThisTurn,
      storms,
      part,
    };

    // 3. Animate
    startPlayback(frames, storms);
  }, [isPlaying, startPlayback]);

  const onModeChange = useCallback((m: PlacementMode) => {
    setMode(m);
    modeRef.current = m;
    canvasRef.current?.requestDraw();
  }, []);

  // Plant a new seed: clear the save and reset every bit of run state. Guarded by a
  // confirm because it discards the current tree.
  const onNewGame = useCallback(() => {
    if (
      !window.confirm(
        "Plant a new seed? This ends your current tree and starts over.",
      )
    )
      return;
    // Stop any in-flight playback.
    const pb = playbackRef.current;
    if (pb) cancelAnimationFrame(pb.rafId);
    playbackRef.current = null;

    clearSave();
    const fresh = createInitialState();
    gameRef.current = fresh;
    const planning = createPlanningState(bankedEnergy(fresh.cells));
    planningRef.current = planning;
    summaryInputRef.current = null;

    setMode("branch");
    modeRef.current = "branch";
    setEnergy(planning.energyAvailable);
    setEnergyTotal(planning.energyAvailable);
    setCanAdvance(true);
    setSeasonYear({
      season: fresh.season,
      year: fresh.year,
      half: fresh.seasonHalf,
    });
    setIsPlaying(false);
    setProgress(0);
    setForecast(makeForecast(fresh));
    setSummary(null);
    setScore(fresh.score);
    setGoalsView(goalsViewOf(fresh));
    setInspected(null);
    setStormFlash(null);
    setPruneMode(false);
    setPruneSel(new Set());
    canvasRef.current?.recenter();
    canvasRef.current?.requestDraw();
  }, []);

  const onHelp = useCallback(() => setShowIntro(true), []);
  const onDismissIntro = useCallback(() => {
    setShowIntro(false);
    try {
      localStorage.setItem("treegame.introSeen", "1");
    } catch {
      /* ignore */
    }
  }, []);

  // Spring with a bare canopy: the leaves are gone (deciduous) and the player needs
  // to grow new ones to restart photosynthesis. This is the single most confusing
  // moment for new players, so call it out explicitly.
  const planningSeason = seasonYear.season;

  // Reinforced wood unlocks once the tree reaches 30 cells — structural tradeoffs only
  // matter once there's real structure to reinforce. Not seasonal (unlike flowers).
  const reinforcedUnlocked =
    gameRef.current.goals.completed.includes("thirty-cells");

  // Flower mode unlocks in spring once the tree has reached 30 cells (milestone 6).
  const flowerUnlocked =
    planningSeason === "spring" &&
    gameRef.current.goals.completed.includes("thirty-cells");

  // In flower mode with nowhere to bloom, tell the player WHY (the #1 flower confusion):
  // blooms need a healthy branch (>60%) with an open or leafy hex beside it.
  const flowerNoSpots =
    !isPlaying &&
    flowerUnlocked &&
    mode === "flower" &&
    getValidPlacements("flower", gameRef.current, planningRef.current).size ===
      0;

  let leafCount = 0;
  for (const c of gameRef.current.cells.values()) {
    if (c.type === "leaf") leafCount++;
  }
  const leafless = leafCount === 0;
  // Only prompt to re-leaf if the tree has actually grown a leaf before (the first-leaf
  // milestone) — never on a brand-new seed that has simply never had leaves yet.
  const hasGrownLeavesBefore =
    gameRef.current.goals.completed.includes("first-leaf");
  const springReLeaf =
    !isPlaying &&
    planningSeason === "spring" &&
    leafless &&
    hasGrownLeavesBefore;

  // Gentle unspent-energy nudge: early years, growth seasons only (hoarding into
  // fall/winter is correct, so it's suppressed there). Suppressed when the more
  // specific spring re-leaf hint is showing.
  const showNudge =
    !isPlaying &&
    !springReLeaf &&
    seasonYear.year <= 4 &&
    planningSeason !== "fall" &&
    planningSeason !== "winter" &&
    energyTotal > 0 &&
    energyRemaining > 0.3 * energyTotal;

  // Bulk-prune preview: the full removal set (selection + everything it disconnects) is
  // shown in red on the canvas, and its size/cost drive the HUD confirm button.
  const pruneRemoval = pruneMode
    ? computeMultiRemoval(gameRef.current.cells, pruneSel)
    : EMPTY_PRUNE;
  const pruneSelCost = pruneMode
    ? pruneSelectionCost(gameRef.current.cells, pruneSel)
    : 0;
  const pruneRemovesAll =
    pruneMode && removesEntireTree(gameRef.current.cells, pruneRemoval);

  return (
    <div className="app-root">
      <GameCanvas
        ref={canvasRef}
        gameRef={gameRef as RefObject<GameState>}
        planningRef={planningRef as RefObject<PlanningState>}
        modeRef={modeRef as RefObject<PlacementMode>}
        isPlaying={isPlaying}
        inspectedKey={pruneMode ? null : (inspected?.key ?? null)}
        pruneSet={
          pruneMode ? pruneRemoval : (inspected?.pruneSet ?? EMPTY_PRUNE)
        }
        overlay={overlay}
        pruneMode={pruneMode}
        onTap={onTap}
      />
      <HUD
        energyRemaining={energyRemaining}
        energyTotal={energyTotal}
        season={seasonYear.season}
        seasonHalf={seasonYear.half}
        year={seasonYear.year}
        score={score}
        forecast={forecast}
        currentGoal={goalsView.current}
        completedGoals={goalsView.completedCount}
        showNudge={showNudge}
        springReLeaf={springReLeaf}
        flowerNoSpots={flowerNoSpots}
        mode={mode}
        reinforcedUnlocked={reinforcedUnlocked}
        flowerUnlocked={flowerUnlocked}
        canAdvance={canAdvance}
        isPlaying={isPlaying}
        playbackProgress={playbackProgress}
        playbackStats={playStats}
        overlay={overlay}
        onOverlayChange={setOverlay}
        pruneMode={pruneMode}
        pruneCount={pruneRemoval.size}
        pruneCost={pruneSelCost}
        pruneRemovesAll={pruneRemovesAll}
        onTogglePrune={onTogglePrune}
        onConfirmPrune={onConfirmPrune}
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
          removesAll={inspected.removesAll}
          pruneable={isPruneable(inspected.cell)}
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
      {summary && (
        <SeasonSummary data={summary} onDismiss={() => setSummary(null)} />
      )}
    </div>
  );
}
