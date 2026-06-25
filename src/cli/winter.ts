// Winter wood-survival check. Reproduces the playtest bug: a sizeable deciduous tree goes
// bare every winter (no canopy → no transpiration → upper structure dries out), and the
// OLD health rule (`water ≤ 0.5 → target 0.0`) then decayed that dry upper wood into
// deadwood every single year — a size-punishing death with no counterplay, and the source
// of the late-game "pile of dead crap to prune".
//
// With the fix (dry wood floors at WOOD_DRY_HEALTH = 0.5), dry wood idles dormant and
// re-greens when the canopy returns; deadwood from thirst should be ~0.
//
// Run: npx tsx src/cli/winter.ts
import { Headless } from "./headless";
import { surfaceR } from "../sim/terrain";

function cells(g: Headless) {
  return [...g.game.cells.values()];
}
function deepestRoot(g: Headless) {
  let best: { q: number; r: number } | null = null;
  for (const c of cells(g))
    if (c.type === "tree" && c.r >= surfaceR(c.q))
      if (!best || c.r > best.r) best = { q: c.q, r: c.r };
  return best;
}
function trunkTop(g: Headless) {
  let best: { q: number; r: number } | null = null;
  for (const c of cells(g))
    if (c.type === "tree") if (!best || c.r < best.r) best = { q: c.q, r: c.r };
  return best;
}
function extendDown(g: Headless, n: number) {
  for (let i = 0; i < n; i++) {
    const d = deepestRoot(g);
    if (!d) return;
    if (
      !g.place(d.q, d.r + 1, "branch") &&
      !g.place(d.q + 1, d.r + 1, "branch") &&
      !g.place(d.q - 1, d.r + 1, "branch")
    )
      return;
  }
}
function extendUp(g: Headless, n: number) {
  for (let i = 0; i < n; i++) {
    const t = trunkTop(g);
    if (!t) return;
    if (
      !g.place(t.q, t.r - 1, "branch") &&
      !g.place(t.q + 1, t.r - 1, "branch") &&
      !g.place(t.q - 1, t.r - 1, "branch")
    )
      return;
  }
}
function widen(g: Headless, n: number) {
  let placed = 0;
  for (const [k, t] of g.validPlacements("branch")) {
    if (placed >= n) break;
    if (t !== "tree") continue;
    const [q, r] = k.split(",").map(Number);
    if (r >= surfaceR(q)) continue;
    if (g.place(q, r, "branch")) placed++;
  }
}
function countType(g: Headless, type: string) {
  return cells(g).filter((c) => c.type === type).length;
}
function dryWood(g: Headless) {
  // above-ground wood the OLD rule would have been killing
  return cells(g).filter(
    (c) => c.type === "tree" && c.r < surfaceR(c.q) && c.water <= 0.5,
  ).length;
}

const g = new Headless(2024);
console.log(
  "year  season  living  deadwood  dryWood  topBand(health/min)  woodAvgHealth",
);
for (let y = 1; y <= 5; y++) {
  for (let s = 0; s < 4; s++) {
    const season = g.season;
    // tall build: deep roots, height ~11, width 3 (canopy auto-grows on the lit hexes)
    if (season !== "winter" && season !== "fall") {
      if (g.year <= 4) {
        extendDown(g, 2);
        extendUp(g, 1);
        widen(g, 2);
      }
    } else if (season === "winter") {
      extendDown(g, 2); // roots are insulated; only winter action
    }
    g.advance();
    const b = g.bands().top;
    const woodCells = cells(g).filter(
      (c) => c.type === "tree" && c.r < surfaceR(c.q),
    );
    const avgH = woodCells.length
      ? (
          woodCells.reduce((a, c) => a + c.health, 0) / woodCells.length
        ).toFixed(2)
      : "—";
    console.log(
      `${String(g.year).padStart(3)}  ${season.padEnd(7)} ${String(g.livingCount()).padStart(5)}  ${String(countType(g, "deadwood")).padStart(7)}  ${String(dryWood(g)).padStart(6)}  ${b ? `${b.health}/${b.minHealth}` : "—"}            ${avgH}`,
    );
  }
}
console.log(
  "\nExpect: deadwood stays ~0 even with lots of dryWood (the old rule would have converted that dryWood to deadwood every winter).",
);
console.log(g.render());
