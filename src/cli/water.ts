// Drought-canopy diagnostic: can a tall tree keep its canopy alive through drought, and do
// deep roots (the water table) help? Direct-constructs identical trees differing only in
// root depth, runs drought summers, reports canopy/upper-wood water + health.
// Run: npx tsx src/cli/water.ts
import { createInitialState, type GameState } from "../game/state";
import { runSeason, mulberry32 } from "../sim/simulate";
import { generateWeather } from "../sim/weather";
import { surfaceR } from "../sim/terrain";
import { hexKey } from "../sim/grid";
import type { Cell } from "../sim/cells";

// height-10, width-3 trunk; 16-leaf canopy hugging the top rows; roots straight down to
// `rootDepth` in soil (deep soil at depth ≥ 18 is the always-wet water table). `soilW` sets
// the shallow-soil starting moisture (low = already drawn down).
function build(rootDepth: number, soilW: number): GameState {
  const g = createInitialState();
  const cells = new Map<string, Cell>();
  const S = surfaceR(0);
  const tree = (q: number, r: number, w = 5): Cell => ({
    q,
    r,
    type: "tree",
    water: w,
    energy: 5,
    health: 1,
    rot: 0,
    age: 3,
  });
  for (let h = 1; h <= 10; h++)
    for (const c of [0, -1, 1]) cells.set(hexKey(c, S - h), tree(c, S - h));
  let placed = 0;
  for (let h = 10; h >= 7 && placed < 16; h--)
    for (const c of [0, -1, 1])
      for (const dq of [c - 1, c + 1]) {
        const k = hexKey(dq, S - h);
        if (!cells.has(k)) {
          cells.set(k, {
            q: dq,
            r: S - h,
            type: "leaf",
            water: 5,
            energy: 5,
            health: 1,
            rot: 0,
            age: 1,
          });
          placed++;
        }
      }
  for (let d = 0; d <= rootDepth; d++)
    for (const c of [0, -1, 1]) cells.set(hexKey(c, S + d), tree(c, S + d, 6));
  for (let d = -1; d <= rootDepth + 1; d++)
    for (let c = -4; c <= 4; c++) {
      const k = hexKey(c, S + d);
      if (!cells.has(k) && S + d >= surfaceR(c))
        cells.set(k, {
          q: c,
          r: S + d,
          type: "soil",
          water: S + d - surfaceR(c) >= 18 ? 20 : soilW,
          energy: 0,
          health: 1,
          rot: 0,
          age: 0,
        });
    }
  return { ...g, cells, season: "summer" };
}

function run(label: string, rootDepth: number, soilW: number, seasons: number) {
  let st = build(rootDepth, soilW);
  const w = generateWeather("summer", 5, st.worldSeed);
  const drought = { ...w, isDrought: true, rain: w.rain.map(() => false) };
  for (let i = 0; i < seasons; i++) {
    const f = runSeason(st, mulberry32(st.rngSeed), drought).frames;
    st = { ...f[f.length - 1], season: "summer" };
  }
  const S = surfaceR(0);
  const leaves = [...st.cells.values()].filter((c) => c.type === "leaf");
  const upWood = [...st.cells.values()].filter(
    (c) => c.type === "tree" && S - c.r >= 7,
  );
  const avg = (cs: Cell[], g: (c: Cell) => number) =>
    cs.length ? cs.reduce((a, c) => a + g(c), 0) / cs.length : 0;
  console.log(
    `${label}: canopy leaves w${avg(leaves, (c) => c.water).toFixed(1)} h${avg(leaves, (c) => c.health).toFixed(2)} (${leaves.length}/16 left) | upper wood w${avg(upWood, (c) => c.water).toFixed(1)} h${avg(upWood, (c) => c.health).toFixed(2)}`,
  );
}

console.log("Single drought summer (soil starts at 8):");
run("  shallow roots (12)", 12, 8, 1);
run("  deep roots    (22)", 22, 8, 1);
console.log(
  "\nSustained drought (depleted soil 3, two consecutive drought summers):",
);
run("  shallow roots (12)", 12, 3, 2);
run("  deep roots    (22)", 22, 3, 2);
