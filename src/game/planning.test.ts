import { describe, it, expect } from "vitest";
import {
  createPlanningState,
  handleTap,
  applyPlanCommit,
  applySeasonAdvance,
  bankedEnergy,
  type PlanningState,
} from "./planning";
import { hexKey } from "../sim/grid";
import { TerrainGen, surfaceR } from "../sim/terrain";
import type { GameState } from "./state";
import type { Cell } from "../sim/cells";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeState(cells: Cell[]): GameState {
  const map = new Map<string, Cell>();
  for (const c of cells) map.set(hexKey(c.q, c.r), c);
  return {
    cells: map,
    terrain: new TerrainGen(),
    season: "spring",
    seasonHalf: 0,
    year: 1,
    score: 0,
    rngSeed: 42,
    worldSeed: 99,
    goals: { completed: [], peakCells: 1 },
  };
}

function mkCell(
  q: number,
  r: number,
  type: Cell["type"],
  opts: { water?: number; energy?: number } = {},
): Cell {
  return {
    q,
    r,
    type,
    water: opts.water ?? 5,
    energy: opts.energy ?? 5,
    health: 1,
    rot: 0,
    age: 0,
  };
}

// Stage a cell via handleTap and assert it succeeded.
function stage(
  q: number,
  r: number,
  mode: "branch" | "flower",
  game: GameState,
  p: PlanningState,
): PlanningState {
  const result = handleTap(q, r, mode, game, p);
  expect(result.kind).toBe("placed");
  return result.planning!;
}

// ─── budget enforcement ───────────────────────────────────────────────────────

describe("handleTap — energy budget", () => {
  it("rejects a placement that would exceed a fractional budget", () => {
    // surfaceR(0) = 0; the seed sits at (0,0). Budget 1.5: one cell fits, two don't.
    const game = makeState([mkCell(0, 0, "tree")]);
    let p = createPlanningState(1.5);
    p = stage(0, -1, "branch", game, p);
    const second = handleTap(0, -2, "branch", game, p);
    expect(second.kind).toBe("rejected_energy"); // 1 + 1 = 2 > 1.5
  });
});

// ─── season advance: energy accounting ────────────────────────────────────────

describe("applySeasonAdvance — energy economy", () => {
  it("deducts placement cost proportionally from pre-existing living cells", () => {
    // Seed with 8 energy; stage 2 cells (cost 2). After advance the seed should
    // hold 6 (8 × (1 − 2/8)) and each new cell 1 — total banked unchanged at 8.
    const game = makeState([mkCell(0, 0, "tree", { energy: 8 })]);
    let p = createPlanningState(8);
    p = stage(0, -1, "branch", game, p);
    p = stage(0, -2, "branch", game, p);

    const after = applySeasonAdvance(game, p);
    expect(after.cells.get(hexKey(0, 0))!.energy).toBeCloseTo(6, 5);
    expect(after.cells.get(hexKey(0, -1))!.energy).toBe(1);
    expect(after.cells.get(hexKey(0, -2))!.energy).toBe(1);
    expect(bankedEnergy(after.cells)).toBeCloseTo(8, 5);
  });

  it("staging a branch over a leaf replaces it; the branch survives advance", () => {
    // Leaves auto-grow, but the player can still grow wood up through the canopy — the
    // tapped leaf is replaced by the staged branch (cost 1).
    const game = makeState([
      mkCell(0, 0, "tree", { energy: 8 }),
      mkCell(0, -1, "leaf", { energy: 2 }),
    ]);
    let p = createPlanningState(10);
    p = stage(0, -1, "branch", game, p); // stage a branch over the leaf
    expect(p.energySpent).toBeCloseTo(1, 5); // +1 for the branch

    const after = applySeasonAdvance(game, p);
    const cell = after.cells.get(hexKey(0, -1));
    expect(cell).toBeDefined();
    expect(cell!.type).toBe("tree"); // staged branch replaced the leaf
    expect(cell!.staged).toBeUndefined(); // staged flag fully dropped
  });

  it("never drives payer energy negative even if payers hold less than the cost", () => {
    // Seed holds 1 energy but the budget (set at planning start) was higher.
    const game = makeState([mkCell(0, 0, "tree", { energy: 1 })]);
    let p = createPlanningState(3);
    p = stage(0, -1, "branch", game, p);
    p = stage(0, -2, "branch", game, p);
    p = stage(1, -1, "branch", game, p);

    const after = applySeasonAdvance(game, p);
    expect(after.cells.get(hexKey(0, 0))!.energy).toBeGreaterThanOrEqual(0);
  });

  it("advances season and year correctly", () => {
    const game = {
      ...makeState([mkCell(0, 0, "tree")]),
      season: "winter" as const,
      year: 3,
    };
    const after = applySeasonAdvance(game, createPlanningState(5));
    expect(after.season).toBe("spring");
    expect(after.year).toBe(4);
  });
});

describe("applyPlanCommit — mid-season checkpoint commit", () => {
  it("commits staged cells and deducts energy WITHOUT advancing the season", () => {
    const game = {
      ...makeState([mkCell(0, 0, "tree", { energy: 8 })]),
      season: "summer" as const,
      year: 2,
    };
    let p = createPlanningState(8);
    p = stage(0, -1, "branch", game, p);

    const after = applyPlanCommit(game, p);
    // Staged growth committed and cost deducted, exactly like a full advance...
    expect(after.cells.get(hexKey(0, -1))!.type).toBe("tree");
    expect(bankedEnergy(after.cells)).toBeCloseTo(8, 5);
    // ...but the season/year are untouched (we stay in-season for the second half).
    expect(after.season).toBe("summer");
    expect(after.year).toBe(2);
  });
});

// sanity: surfaceR(0) must be 0 for the coordinates used above
describe("test assumptions", () => {
  it("surfaceR(0) === 0", () => {
    expect(surfaceR(0)).toBe(0);
  });
});
