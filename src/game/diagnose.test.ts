import { describe, it, expect } from "vitest";
import { diagnoseReport } from "./diagnose";
import { createInitialState } from "./state";
import { surfaceR } from "../sim/terrain";
import { hexKey } from "../sim/grid";
import type { GameState } from "./state";
import type { Cell } from "../sim/cells";

function mk(
  q: number,
  r: number,
  type: Cell["type"],
  water: number,
  health: number,
  energy = 5,
): Cell {
  return { q, r, type, water, energy, health, rot: 0, age: 1 };
}

// A bare, well-watered, healthy tree (trunk + roots, no leaves yet).
function healthyTree(): GameState {
  const g = createInitialState();
  g.season = "summer";
  g.cells.clear();
  const s = surfaceR(0);
  for (let h = 0; h < 6; h++)
    g.cells.set(hexKey(0, s - h), mk(0, s - h, "tree", 8, 1));
  for (let d = 1; d <= 4; d++)
    g.cells.set(hexKey(0, s + d), mk(0, s + d, "tree", 8, 1));
  return g;
}

// A tall narrow trunk whose lifted canopy is starved: wet base, dry+graying top.
function starvingTree(): GameState {
  const g = createInitialState();
  g.season = "summer";
  g.cells.clear();
  const s = surfaceR(0);
  for (let h = 0; h < 12; h++) {
    const water = Math.max(9 - h * 0.7, 0.3); // gradient: wet base → dry top
    const health = h < 6 ? 1.0 : 0.4; // top half graying
    g.cells.set(hexKey(0, s - h), mk(0, s - h, "tree", water, health));
  }
  for (let d = 1; d <= 4; d++)
    g.cells.set(hexKey(0, s + d), mk(0, s + d, "tree", 8, 1));
  for (const [q, h] of [
    [1, 11],
    [-1, 11],
    [1, 10],
    [-1, 10],
  ] as const)
    g.cells.set(hexKey(q, s - h), mk(q, s - h, "leaf", 0.6, 0.3));
  return g;
}

describe("diagnoseReport", () => {
  it("reports a per-altitude vertical profile and overall living health", () => {
    const r = diagnoseReport(healthyTree());
    expect(r).toContain("Vertical profile");
    expect(r).toContain("Avg living health");
    // Bands list from the top of the tree down — the 1–4 base band is present.
    expect(r).toMatch(/1–4/);
  });

  it("calls a genuinely healthy tree healthy", () => {
    const r = diagnoseReport(healthyTree());
    expect(r).toContain("looks healthy");
    expect(r).not.toContain("starves with height");
    expect(r).not.toContain("in decline");
  });

  it("does NOT call a dying tree balanced/healthy, and names the real problem", () => {
    const r = diagnoseReport(starvingTree());
    // The whole point of the upgrade: a stressed tree must not read as fine.
    expect(r).not.toContain("looks healthy");
    expect(r).not.toContain("looks balanced");
    // The vertical gradient and the graying canopy are both surfaced in the verdict.
    expect(r).toContain("starves with height");
    expect(r).toContain("graying");
    // Headline health flags the decline.
    expect(r).toMatch(/Avg living health\s+0\.\d+\s+(⚠️|🛑)/);
  });
});
