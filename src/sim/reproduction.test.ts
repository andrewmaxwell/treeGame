import { describe, it, expect } from "vitest";
import { setFruit, ripenFruit, matureFruit, runSeason } from "./simulate";
import { computeStructure } from "./structure";
import { mulberry32 } from "./rng";
import { generateWeather } from "./weather";
import { hexKey } from "./grid";
import { TerrainGen, surfaceR } from "./terrain";
import type { GameState } from "../game/state";
import type { Cell } from "./cells";
import {
  FRUIT_START_MATURITY,
  FRUIT_RIPEN_RATE,
  FRUIT_DECLINE_RATE,
  FLOWER_SET_HEALTH,
} from "./cells";

function makeState(cells: Cell[], over: Partial<GameState> = {}): GameState {
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
    ...over,
  };
}

function mk(
  q: number,
  r: number,
  type: Cell["type"],
  opts: Partial<Cell> = {},
): Cell {
  return {
    q,
    r,
    type,
    water: 5,
    energy: 5,
    health: 1,
    rot: 0,
    age: 0,
    ...opts,
  };
}

// ─── setFruit (spring → summer) ─────────────────────────────────────────────────

describe("setFruit", () => {
  it("a healthy flower pollinates into a fruit at the starting maturity", () => {
    const s = setFruit(makeState([mk(0, -1, "flower", { health: 1 })]));
    const c = s.cells.get(hexKey(0, -1))!;
    expect(c.type).toBe("fruit");
    expect(c.maturity).toBe(FRUIT_START_MATURITY);
  });

  it("a flower at/below the set-health bar drops (no fruit)", () => {
    const s = setFruit(
      makeState([mk(0, -1, "flower", { health: FLOWER_SET_HEALTH })]),
    );
    expect(s.cells.has(hexKey(0, -1))).toBe(false);
  });

  it("leaves and wood are untouched", () => {
    const s = setFruit(makeState([mk(0, 0, "tree"), mk(0, -1, "leaf")]));
    expect(s.cells.get(hexKey(0, 0))!.type).toBe("tree");
    expect(s.cells.get(hexKey(0, -1))!.type).toBe("leaf");
  });
});

// ─── matureFruit (summer carry) ──────────────────────────────────────────────────

describe("matureFruit", () => {
  it("a well-fed fruit (water ≥ 2) ripens by the ripen rate", () => {
    const s = matureFruit(
      makeState([mk(0, -1, "fruit", { water: 5, maturity: 0.5 })]),
    );
    expect(s.cells.get(hexKey(0, -1))!.maturity).toBeCloseTo(
      0.5 + FRUIT_RIPEN_RATE,
    );
  });

  it("maturity never exceeds 1.0", () => {
    const s = matureFruit(
      makeState([mk(0, -1, "fruit", { water: 5, maturity: 0.99 })]),
    );
    expect(s.cells.get(hexKey(0, -1))!.maturity).toBe(1.0);
  });

  it("a thirsty fruit (water < 1) regresses by the decline rate", () => {
    const s = matureFruit(
      makeState([mk(0, -1, "fruit", { water: 0.5, maturity: 0.5 })]),
    );
    expect(s.cells.get(hexKey(0, -1))!.maturity).toBeCloseTo(
      0.5 - FRUIT_DECLINE_RATE,
    );
  });

  it("holds steady at intermediate water (1 ≤ water < 2)", () => {
    const s = matureFruit(
      makeState([mk(0, -1, "fruit", { water: 1.5, maturity: 0.5 })]),
    );
    expect(s.cells.get(hexKey(0, -1))!.maturity).toBe(0.5);
  });

  it("aborts (drops) when sustained thirst drives maturity to ≤ 0", () => {
    let s = makeState([
      mk(0, -1, "fruit", { water: 0, maturity: FRUIT_START_MATURITY }),
    ]);
    // 0.15 / 0.04 = 3.75 → aborts within 4 thirsty ticks.
    for (let i = 0; i < 4; i++) s = matureFruit(s);
    expect(s.cells.has(hexKey(0, -1))).toBe(false);
  });
});

// ─── ripenFruit (fall harvest) ───────────────────────────────────────────────────

describe("ripenFruit", () => {
  it("a ripe fruit yields one seed and drops", () => {
    const { state, harvested } = ripenFruit(
      makeState([mk(0, -1, "fruit", { maturity: 1.0 })], { score: 2 }),
    );
    expect(harvested).toBe(1);
    expect(state.score).toBe(3);
    expect(state.cells.has(hexKey(0, -1))).toBe(false);
  });

  it("an unripe fruit drops with no seed", () => {
    const { state, harvested } = ripenFruit(
      makeState([mk(0, -1, "fruit", { maturity: 0.8 })], { score: 2 }),
    );
    expect(harvested).toBe(0);
    expect(state.score).toBe(2);
    expect(state.cells.has(hexKey(0, -1))).toBe(false);
  });

  it("scores one seed per ripe fruit across many", () => {
    const { harvested } = ripenFruit(
      makeState([
        mk(0, -1, "fruit", { maturity: 1.0 }),
        mk(1, -1, "fruit", { maturity: 1.0 }),
        mk(2, -1, "fruit", { maturity: 0.3 }),
      ]),
    );
    expect(harvested).toBe(2);
  });
});

// ─── structural load (fruit is heavy) ────────────────────────────────────────────

describe("fruit structural load", () => {
  it("a fruit on a branch raises the limb stress vs the same branch bare", () => {
    // Root at surface, a short horizontal arm reaching right.
    const sr = surfaceR(0);
    const arm: Cell[] = [
      mk(0, sr, "tree"), // root anchor (underground)
      mk(0, sr - 1, "tree"), // trunk above ground
      mk(1, sr - 1, "tree"),
      mk(2, sr - 1, "tree"), // tip
    ];
    const bare = computeStructure(
      new Map(arm.map((c) => [hexKey(c.q, c.r), c])),
    );
    const withFruit = computeStructure(
      new Map(
        [...arm, mk(3, sr - 1, "fruit")].map((c) => [hexKey(c.q, c.r), c]),
      ),
    );
    const maxStress = (m: Map<string, number>) => Math.max(...m.values());
    expect(maxStress(withFruit.stress)).toBeGreaterThan(maxStress(bare.stress));
  });
});

// ─── full-season integration ─────────────────────────────────────────────────────

describe("runSeason — reproductive wiring", () => {
  it("a healthy spring flower sets to fruit by season end", () => {
    const sr = surfaceR(0);
    // A small well-watered tree with a flower on its tip.
    const state = makeState(
      [
        mk(0, sr + 1, "tree", { water: 9 }), // root
        mk(0, sr, "tree", { water: 9 }),
        mk(0, sr - 1, "tree", { water: 9, energy: 9 }),
        mk(0, sr - 2, "leaf", { water: 8, energy: 6 }),
        mk(1, sr - 2, "flower", { water: 6, energy: 6, health: 1 }),
      ],
      { season: "spring" },
    );
    const weather = generateWeather("spring", 1, state.worldSeed);
    const frames = runSeason(state, mulberry32(state.rngSeed), weather).frames;
    const final = frames[frames.length - 1];
    const flowerKey = hexKey(1, sr - 2);
    const c = final.cells.get(flowerKey);
    expect(c?.type).toBe("fruit");
  });

  it("a ripe fruit carried into fall scores a seed", () => {
    const sr = surfaceR(0);
    const state = makeState(
      [
        mk(0, sr + 1, "tree", { water: 9 }),
        mk(0, sr, "tree", { water: 9 }),
        mk(0, sr - 1, "tree", { water: 9 }),
        mk(1, sr - 1, "fruit", { water: 6, maturity: 1.0 }),
      ],
      { season: "fall", score: 0 },
    );
    const weather = generateWeather("fall", 1, state.worldSeed);
    const frames = runSeason(state, mulberry32(state.rngSeed), weather).frames;
    expect(frames[frames.length - 1].score).toBe(1);
  });
});
