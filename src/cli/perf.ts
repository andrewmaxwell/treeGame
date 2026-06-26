// Performance profiler: replicate the "more cells = slower" slowdown deterministically.
// Synthesizes connected trees of a target size, then times the functions that run in the
// hot paths — the per-tick sim AND the per-render-frame recomputes that the canvas loop
// fires on every dirty frame (pan/zoom/playback). Run: npx tsx src/cli/perf.ts
import { performance } from "node:perf_hooks";
import { createInitialState, type GameState } from "../game/state";
import { createPlanningState, getValidPlacements } from "../game/planning";
import { generateWeather } from "../sim/weather";
import {
  runSeasonPart,
  mulberry32,
  computeLight,
  autoLeafPreview,
} from "../sim/simulate";
import { computeStructure } from "../sim/structure";
import { surfaceR } from "../sim/terrain";
import { hexKey } from "../sim/grid";
import { SEASON_PARAMS } from "../sim/weather";
import type { Cell } from "../sim/cells";

// Build a connected tree of roughly `target` living cells: a wide trunk, a triangular
// leafy canopy, and a root fan. Shape is realistic enough to exercise the BFS / layer
// integration / light columns the way a real grown tree does.
function buildTree(target: number): GameState {
  const g = createInitialState();
  const cells = new Map<string, Cell>();
  const mk = (q: number, r: number, type: Cell["type"]): Cell => ({
    q,
    r,
    type,
    water: 6,
    energy: 5,
    health: 1,
    rot: 0,
    age: 3,
    ...(type === "fruit" ? { maturity: 0.5 } : {}),
  });
  const set = (q: number, r: number, type: Cell["type"]) =>
    cells.set(hexKey(q, r), mk(q, r, type));

  const sr = surfaceR(0);
  let count = 0;
  // Trunk: a column ~5 wide growing up, height grows with target.
  const trunkH = Math.max(8, Math.round(Math.sqrt(target) * 1.1));
  const trunkW = 3;
  for (let h = 0; h <= trunkH; h++) {
    for (let w = -trunkW; w <= trunkW; w++) {
      if (Math.abs(w) > trunkW - Math.floor(h / 8)) continue;
      set(w, sr - h, "tree");
      count++;
    }
  }
  // Roots: a widening fan below ground.
  for (let h = 1; h <= trunkH; h++) {
    const width = Math.min(2 + h, 18);
    for (let w = -width; w <= width; w++) {
      if ((w + h) % 2 === 0) continue; // sparse tendrils
      set(w, sr + h, "tree");
      count++;
    }
  }
  // Canopy: triangular leaf/branch mass above the trunk, widening downward.
  let r = sr - trunkH;
  let half = 1;
  while (count < target) {
    for (let w = -half; w <= half; w++) {
      const k = hexKey(w, r);
      if (cells.has(k)) continue;
      // mostly leaves with a branch skeleton every few cells, a few fruit
      const type: Cell["type"] =
        Math.abs(w) % 5 === 0 ? "tree" : w % 11 === 0 ? "fruit" : "leaf";
      set(w, r, type);
      count++;
      if (count >= target) break;
    }
    r--;
    half++;
    if (half > 60) {
      // canopy got tall enough; widen a flat extra slab so we can reach 10k+
      r = sr - trunkH - 1;
    }
  }
  return { ...g, cells, season: "spring" };
}

function bench(label: string, fn: () => void, iters: number): number {
  // warmup
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (performance.now() - t0) / iters;
  console.log(`  ${label.padEnd(34)} ${dt.toFixed(2)} ms/call`);
  return dt;
}

const sizes = [1000, 3000, 10000];
for (const size of sizes) {
  const game = buildTree(size);
  const living = [...game.cells.values()].filter(
    (c) => c.type !== "soil" && c.type !== "rock",
  ).length;
  const planning = createPlanningState(9999);
  const weather = generateWeather("spring", game.year, game.worldSeed);
  const p = SEASON_PARAMS.spring;

  console.log(`\n=== ${living} living cells ===`);

  // Per-render-frame recomputes (fire on EVERY dirty frame during planning: pan/zoom)
  bench("computeStructure", () => computeStructure(game.cells), 20);
  bench(
    "autoLeafPreview",
    () => autoLeafPreview(game, p.sunAngleDeg, p.intensity),
    20,
  );
  bench("computeLight", () => computeLight(game, p.sunAngleDeg), 20);
  bench(
    "getValidPlacements",
    () => getValidPlacements("branch", game, planning),
    20,
  );

  // The full half-season sim (one Advance Season) — allocates 30 frames.
  bench(
    "runSeasonPart (30 ticks)",
    () => runSeasonPart(game, mulberry32(1), weather, 0),
    3,
  );
}
