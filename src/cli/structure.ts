// Structural-stress calibration harness for the load-sharing bending model in
// sim/structure.ts. Builds canonical trees and prints each one's stress field so the
// MOMENT_W / WIND_W / WIND_AREA / strength constants can be tuned against the storm
// thresholds (minor 1.2 / moderate 0.9 / severe 0.6) and STRESS_WARN (0.8).
//
// What to look for:
//   • a normal balanced tree stays under STRESS_WARN (no red, survives minor storms)
//   • a tall SKINNY trunk reddens hard at its base (wind + pixel lean), ~0 at the top
//   • a tall THICK trunk of the same height is far lower AND evenly spread (the fix)
//   • a long horizontal branch is ~0 at the tip, rising toward the trunk
//   • a heavy branch onto the MIDDLE of a thick trunk does NOT light up one column —
//     the cross-section shares the load (the reported "random hot cell" bug)
//   • a REAL grown tree has no wild same-row stress outlier
//
// Run: npx tsx src/cli/structure.ts
import { computeStructure, STRESS_WARN } from "../sim/structure";
import { hexKey, hexPixelX } from "../sim/grid";
import { surfaceR } from "../sim/terrain";
import type { Cell } from "../sim/cells";
import { Headless } from "./headless";

function cell(q: number, r: number, type: Cell["type"] = "tree"): Cell {
  return { q, r, type, water: 5, energy: 5, health: 1, rot: 0, age: 1 };
}
function toMap(list: Cell[]): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const c of list) m.set(hexKey(c.q, c.r), c);
  return m;
}

// A vertical trunk `width` cells across, every column contiguous from underground
// (r = 2) up to r = -height. Matches the vtrunk fixture in structure.test.ts.
function vtrunk(height: number, width = 1): Cell[] {
  const out: Cell[] = [];
  for (let q = 0; q < width; q++)
    for (let r = 2; r >= -height; r--) out.push(cell(q, r));
  return out;
}

function report(name: string, cells: Map<string, Cell>): void {
  const { stress } = computeStructure(cells);
  let max = 0,
    maxKey = "";
  let over = 0;
  for (const [k, s] of stress) {
    if (s > max) {
      max = s;
      maxKey = k;
    }
    if (s > STRESS_WARN) over++;
  }
  console.log(
    `${name}: cells=${cells.size} maxStress=${max.toFixed(2)} @${maxKey} ` +
      `over-warn=${over}`,
  );
}

// Per-cell dump, sorted top→down.
function dump(name: string, cells: Map<string, Cell>): void {
  const { stress, moment, strength } = computeStructure(cells);
  console.log(`\n── ${name} ──`);
  const rows = [...cells.values()]
    .filter((c) => c.type === "tree" || c.type === "reinforced wood")
    .sort((a, b) => a.r - b.r || hexPixelX(a.q, a.r) - hexPixelX(b.q, b.r));
  for (const c of rows) {
    const k = hexKey(c.q, c.r);
    const tag = c.r >= surfaceR(c.q) ? "root" : "wood";
    console.log(
      `  (${c.q},${c.r}) ${tag} h=${(surfaceR(c.q) - c.r).toString().padStart(2)} ` +
        `stress=${stress.get(k)!.toFixed(3).padStart(6)} ` +
        `moment=${moment.get(k)!.toFixed(1).padStart(6)} ` +
        `strength=${strength.get(k)}`,
    );
  }
}

// ── canonical trees ──────────────────────────────────────────────────────────
console.log("\n═══ canonical trees ═══");

// 1. Lone seed.
report("lone seed", toMap([cell(0, 0)]));

// 2. A normal balanced mid tree: 5-tall trunk, a little girth, a small balanced canopy.
function normalTree(): Cell[] {
  const out = vtrunk(5, 1);
  out.push(cell(-1, 0), cell(1, 0), cell(-1, -1), cell(1, -1));
  for (const [dq, dr] of [
    [-1, 0],
    [1, -1],
    [0, -1],
    [-1, 1],
  ])
    out.push(cell(0 + dq, -5 + dr, "leaf"));
  return out;
}
report("normal balanced tree", toMap(normalTree()));

// 3. Tall SKINNY trunk (height 12, 1 wide) — reddens hard at the base, ~0 at top.
report("tall skinny (h12 w1)", toMap(vtrunk(12, 1)));
dump("tall skinny (h12 w1)", toMap(vtrunk(12, 1)));

// 4. Tall THICK trunk (height 12, 5 wide) — far lower, evenly spread.
report("tall thick  (h12 w5)", toMap(vtrunk(12, 5)));
dump("tall thick (h12 w5)", toMap(vtrunk(12, 5)));

// 5. Long horizontal cantilever (arm length 6 off a short trunk).
function cantilever(n: number): Cell[] {
  const out = [cell(0, 0), cell(0, -1), cell(0, -2), cell(0, -3)];
  for (let q = 1; q <= n; q++) out.push(cell(q, -3));
  return out;
}
dump("horizontal cantilever (len 6)", toMap(cantilever(6)));

// 6. THE BUG REPRO: a heavy branch onto the MIDDLE of a 3-wide trunk. A couple rows
// below the junction the three columns must carry comparable stress (load fanned out).
function branchIntoThickTrunk(): Cell[] {
  const out = vtrunk(9, 3);
  for (let q = 3; q <= 9; q++) out.push(cell(q, -6)); // long branch off the middle
  return out;
}
dump("branch into middle of thick trunk", toMap(branchIntoThickTrunk()));
report("branch into middle of thick trunk", toMap(branchIntoThickTrunk()));

// 7. A REAL tree, grown through the actual placement API + simulated seasons. The acid
// test for the reported bug: flag any above-ground wood cell whose stress is a wild
// outlier versus its same-row neighbours (the "random hot cell").
function aboveWood(g: Headless): Cell[] {
  return [...g.game.cells.values()].filter(
    (c) => c.type === "tree" && c.r < surfaceR(c.q),
  );
}
function rootWood(g: Headless): Cell[] {
  return [...g.game.cells.values()].filter(
    (c) => c.type === "tree" && c.r >= surfaceR(c.q),
  );
}
function realTree(): Headless {
  const g = new Headless();
  for (let yr = 0; yr < 5; yr++) {
    while (g.season === "winter" || g.season === "fall") g.advance();
    for (let i = 0; i < 6; i++) {
      const rs = rootWood(g);
      if (!rs.length) break;
      const d = rs.reduce((a, b) => (b.r > a.r ? b : a));
      if (
        !g.place(d.q, d.r + 1, "branch") &&
        !g.place(d.q + 1, d.r + 1, "branch") &&
        !g.place(d.q - 1, d.r + 1, "branch")
      )
        break;
    }
    for (let i = 0; i < 3; i++) {
      const aw = aboveWood(g);
      const top = aw.length
        ? aw.reduce((a, b) => (b.r < a.r ? b : a))
        : rootWood(g).reduce((a, b) => (b.r < a.r ? b : a));
      if (
        !g.place(top.q, top.r - 1, "branch") &&
        !g.place(top.q + 1, top.r - 1, "branch")
      )
        break;
    }
    for (let pass = 0; pass < 3; pass++)
      for (const [k, t] of g.validPlacements("branch")) {
        if (t !== "tree") continue;
        const [q, r] = k.split(",").map(Number);
        if (r < surfaceR(q) && r >= -5) g.place(q, r, "branch");
      }
    const midRow = aboveWood(g).filter((c) => c.r === -4);
    if (midRow.length) {
      let rm = midRow.reduce((a, b) => (b.q > a.q ? b : a));
      for (let i = 0; i < 5; i++) {
        if (g.place(rm.q + 1, -4, "branch")) rm = { ...rm, q: rm.q + 1 };
        else break;
      }
    }
    g.advance();
  }
  return g;
}

function realTreeReport(): void {
  const g = realTree();
  const { stress } = computeStructure(g.game.cells);
  const wood = aboveWood(g);
  const byRow = new Map<number, Cell[]>();
  for (const c of wood)
    (byRow.get(c.r) ?? byRow.set(c.r, []).get(c.r)!).push(c);
  let worstRatio = 0,
    worstDesc = "";
  let max = 0,
    maxKey = "";
  for (const [, cs] of byRow) {
    const ss = cs
      .map((c) => stress.get(hexKey(c.q, c.r))!)
      .sort((a, b) => a - b);
    const median = ss[Math.floor(ss.length / 2)];
    for (const c of cs) {
      const s = stress.get(hexKey(c.q, c.r))!;
      if (s > max) {
        max = s;
        maxKey = hexKey(c.q, c.r);
      }
      if (cs.length < 3) continue;
      const ratio = s / Math.max(median, 0.05);
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstDesc = `(${c.q},${c.r}) stress=${s.toFixed(2)} vs row-median ${median.toFixed(2)}`;
      }
    }
  }
  console.log("\n═══ REAL grown tree ═══");
  console.log(
    `  ${g.livingCount()} living cells, maxStress=${max.toFixed(2)} @${maxKey}`,
  );
  console.log(
    `  worst same-row stress outlier: ${worstRatio.toFixed(1)}× — ${worstDesc}`,
  );
}
realTreeReport();
