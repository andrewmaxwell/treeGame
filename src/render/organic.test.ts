import { describe, it, expect } from "vitest";
import { treeTopology, woodRadius } from "./organic";
import { surfaceR } from "../sim/terrain";
import { hexKey } from "../sim/grid";
import type { Cell } from "../sim/cells";

function tree(spec: [number, number, Cell["type"]][]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const [q, dr, type] of spec) {
    const r = surfaceR(q) + dr; // dr < 0 is above ground
    cells.set(hexKey(q, r), {
      q,
      r,
      type,
      water: 5,
      energy: 5,
      health: 1,
      rot: 0,
      age: 1,
    });
  }
  return cells;
}

describe("treeTopology (pipe model)", () => {
  // A seed at the surface, a three-cell trunk above it, two roots below, a leaf on top.
  const s = surfaceR(0);
  const cells = tree([
    [0, 0, "tree"],
    [0, -1, "tree"],
    [0, -2, "tree"],
    [0, -3, "tree"],
    [0, 1, "tree"],
    [0, 2, "tree"],
    [0, -4, "leaf"],
  ]);
  const topo = treeTopology(cells);

  it("counts the wood each cell carries, out from the soil line", () => {
    expect(topo.size.get(hexKey(0, s))).toBe(6);
    expect(topo.size.get(hexKey(0, s - 1))).toBe(3);
    expect(topo.size.get(hexKey(0, s - 3))).toBe(1);
    expect(topo.size.get(hexKey(0, s + 1))).toBe(2);
  });

  it("hangs the leaf from the wood beside it", () => {
    expect(topo.twig.get(hexKey(0, s - 4))).toBe(hexKey(0, s - 3));
  });

  it("is cached per cell map", () => {
    expect(treeTopology(cells)).toBe(topo);
  });
});

describe("woodRadius", () => {
  it("thickens with supported wood but never overflows its hex", () => {
    const r = 10;
    expect(woodRadius(4, r, false)).toBeGreaterThan(woodRadius(1, r, false));
    expect(woodRadius(10000, r, false)).toBeLessThan(r);
    expect(woodRadius(4, r, true)).toBeLessThan(woodRadius(4, r, false));
  });
});
