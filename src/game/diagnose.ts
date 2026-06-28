// Tree diagnostic report — a dense, plain-text snapshot of a run's health, built from
// a GameState. Pure (no DOM, no fs, no console) so it works both in the browser console
// (App logs it on load) and the headless CLI (src/cli/diagnose.ts).
//
// It answers, with hard numbers instead of eyeballing the canvas: how many leaves are
// net-negative "parasites", canopy water demand vs trunk supply, wood-health and the
// flower-anchor lockout, energy headroom, root depth, and structural stress.

import {
  computeLight,
  PHOTO_COEFF,
  LIGHT_GROUND_FACTOR,
  LIGHT_FULL_HEIGHT,
} from "../sim/simulate";
import { computeStructure, STRESS_WARN } from "../sim/structure";
import { SEASON_PARAMS } from "../sim/weather";
import { surfaceR } from "../sim/terrain";
import { HEX_NEIGHBORS, hexKey } from "../sim/grid";
import { CELL_ENERGY_CAP } from "../sim/cells";
import type { Cell } from "../sim/cells";
import type { GameState } from "./state";

// Metabolism (mirrors metabolize() in simulate.ts; duplicated here so this stays read-only).
const LEAF_WATER = 0.1,
  LEAF_ENERGY = 0.02;
const WOOD_WATER = 0.05;
const FLOWER_ANCHOR_HEALTH = 0.6;
const WOOD_WATER_OK = 3; // wood is fully healthy above this water

function heightLightFactor(q: number, r: number): number {
  const h = surfaceR(q) - r;
  if (h <= 0) return LIGHT_GROUND_FACTOR;
  return Math.min(
    1,
    LIGHT_GROUND_FACTOR + (h / LIGHT_FULL_HEIGHT) * (1 - LIGHT_GROUND_FACTOR),
  );
}

function isUnderground(c: Cell): boolean {
  return c.r >= surfaceR(c.q);
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

function stats(xs: number[]): { min: number; avg: number; max: number } {
  if (xs.length === 0) return { min: 0, avg: 0, max: 0 };
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { min, avg: sum / xs.length, max };
}

export function diagnoseReport(game: GameState): string {
  const out: string[] = [];
  const line = (label: string, value: string) =>
    out.push(`  ${label.padEnd(34)} ${value}`);

  const cells = game.cells;
  const params = SEASON_PARAMS[game.season];
  const intensity = params.intensity;

  // ── Census ────────────────────────────────────────────────────────────────
  const leaves: Cell[] = [],
    woodAbove: Cell[] = [],
    roots: Cell[] = [];
  let flowers = 0,
    fruit = 0,
    deadwood = 0,
    healthSum = 0,
    healthN = 0;
  for (const c of cells.values()) {
    switch (c.type) {
      case "leaf":
        leaves.push(c);
        break;
      case "tree":
      case "reinforced wood":
        (isUnderground(c) ? roots : woodAbove).push(c);
        break;
      case "flower":
        flowers++;
        break;
      case "fruit":
        fruit++;
        break;
      case "deadwood":
        deadwood++;
        continue; // dead — don't fold into living-health average
      default:
        continue; // soil/rock/etc. — not living tissue
    }
    healthSum += c.health;
    healthN++;
  }
  const living =
    leaves.length + woodAbove.length + roots.length + flowers + fruit;
  const overallHealth = healthN > 0 ? healthSum / healthN : 0;

  out.push(
    `\n══ Tree diagnosis — ${game.season} Y${game.year} · score ${game.score} ══\n`,
  );
  line(
    "Living cells",
    `${living}  (leaves ${leaves.length}, trunk/branch ${woodAbove.length}, roots ${roots.length}, flowers ${flowers}, fruit ${fruit})`,
  );
  line("Deadwood", `${deadwood}`);
  line(
    "Avg living health",
    `${overallHealth.toFixed(2)}  ${overallHealth >= 0.75 ? "healthy" : overallHealth >= 0.5 ? "⚠️  stressed" : "🛑 in decline"}`,
  );

  // ── Light & the parasite question ───────────────────────────────────────────
  // A leaf nets energy only if  light·intensity·PHOTO_COEFF·heightFactor > its 0.02
  // upkeep. Below that it is a net energy LOSS and STILL transpires 0.10 water/tick —
  // a parasite. (computeLight is the real per-column self-shading model.)
  const light = computeLight(game, params.sunAngleDeg);
  let parasites = 0,
    freeloaders = 0;
  const leafLightLevels: number[] = [];
  for (const c of leaves) {
    const ll = light.get(hexKey(c.q, c.r)) ?? 0;
    leafLightLevels.push(ll);
    const gen = ll * intensity * PHOTO_COEFF * heightLightFactor(c.q, c.r);
    if (gen <= LEAF_ENERGY) parasites++;
    else if (gen < LEAF_ENERGY * 1.2) freeloaders++;
  }
  const ls = stats(leafLightLevels);
  out.push(`\n── Canopy light (${game.season}, intensity ${intensity}) ──`);
  line(
    "Leaf light level (remaining)",
    `min ${ls.min.toFixed(2)}  avg ${ls.avg.toFixed(2)}  max ${ls.max.toFixed(2)}`,
  );
  line(
    "Net-NEGATIVE leaves (parasites)",
    `${parasites} / ${leaves.length}  (${pct(parasites, leaves.length)}) — cost water+energy, make none`,
  );
  line(
    "Barely-breakeven leaves",
    `${freeloaders} / ${leaves.length}  (${pct(freeloaders, leaves.length)})`,
  );
  out.push(
    "  (a parasite still transpires 0.10 water/tick — pruning it RAISES net energy and frees water)",
  );

  // ── Water supply vs demand ──────────────────────────────────────────────────
  // Demand = transpiration + wood upkeep. Supply proxy = trunk bases × 2 units/tick
  // (each surface-crossing wood cell can conduct at most 2/tick up from the roots).
  const demand =
    leaves.length * LEAF_WATER +
    (woodAbove.length + flowers + fruit) * WOOD_WATER;
  let trunkBases = 0;
  for (const c of woodAbove) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const n = cells.get(hexKey(c.q + dq, c.r + dr));
      if (
        n &&
        (n.type === "tree" || n.type === "reinforced wood") &&
        isUnderground(n)
      ) {
        trunkBases++;
        break;
      }
    }
  }
  const supply = trunkBases * 2;
  const woodWater = stats(woodAbove.map((c) => c.water));
  const leafWater = stats(leaves.map((c) => c.water));
  out.push(`\n── Water ──`);
  line(
    "Canopy demand (units/tick)",
    `${demand.toFixed(1)}  (${leaves.length} leaves×0.10 + ${woodAbove.length + flowers + fruit} wood/repro×0.05)`,
  );
  line(
    "Trunk supply ceiling",
    `${supply.toFixed(1)}  (${trunkBases} surface trunks × 2/tick)`,
  );
  line(
    "Supply ÷ demand",
    `${demand === 0 ? "—" : (supply / demand).toFixed(2)}×  ${supply < demand ? "⚠️  UNDER-WATERED" : "ok"}`,
  );
  line(
    "Above-ground wood water",
    `min ${woodWater.min.toFixed(1)}  avg ${woodWater.avg.toFixed(1)}  max ${woodWater.max.toFixed(1)}  (healthy needs > ${WOOD_WATER_OK})`,
  );
  line(
    "Leaf water",
    `min ${leafWater.min.toFixed(1)}  avg ${leafWater.avg.toFixed(1)}  max ${leafWater.max.toFixed(1)}`,
  );

  // ── Vertical profile (water & health by altitude) ───────────────────────────
  // The global min/avg/max above hides the gradient that kills tall trees: the base
  // stays wet and healthy while the lifted canopy starves (the 2-units/tick conduction
  // cap). Banding above-ground cells by height surfaces that gradient directly — a
  // top band much drier than the base is the "can't water the canopy" signature.
  const BAND = 4; // cells per band
  type Band = { wood: Cell[]; leaf: Cell[] };
  const bands = new Map<number, Band>();
  const getBand = (b: number): Band => {
    let v = bands.get(b);
    if (!v) {
      v = { wood: [], leaf: [] };
      bands.set(b, v);
    }
    return v;
  };
  const bandIndex = (c: Cell) => Math.floor((surfaceR(c.q) - c.r - 1) / BAND);
  for (const c of woodAbove) getBand(bandIndex(c)).wood.push(c);
  for (const c of leaves) getBand(bandIndex(c)).leaf.push(c);
  const bandsHighToLow = [...bands.keys()].sort((a, b) => b - a);
  const bandAvgWater = (b: Band | undefined): number => {
    if (!b) return NaN;
    const xs = [...b.wood, ...b.leaf];
    return xs.length ? xs.reduce((s, c) => s + c.water, 0) / xs.length : NaN;
  };
  // Compact "n  water  hp" column for one cell kind in a band.
  const col = (kind: Cell[]): string => {
    if (kind.length === 0)
      return `${"·".padStart(4)} ${"—".padStart(5)} ${"—".padStart(4)}`;
    const w = stats(kind.map((c) => c.water));
    const h = stats(kind.map((c) => c.health));
    return `${String(kind.length).padStart(4)} ${w.avg.toFixed(1).padStart(5)} ${h.avg.toFixed(2).padStart(4)}`;
  };
  out.push(
    `\n── Vertical profile (height above ground, ${BAND}-cell bands) ──`,
  );
  out.push(
    `  ${"height".padEnd(8)}${"wood  n  watr  hp".padEnd(20)}${"leaf  n  watr  hp"}`,
  );
  if (bandsHighToLow.length === 0) out.push("  (no above-ground cells yet)");
  for (const b of bandsHighToLow) {
    const band = getBand(b);
    const lo = b * BAND + 1,
      hi = (b + 1) * BAND;
    out.push(
      `  ${`${lo}–${hi}`.padEnd(8)}${col(band.wood)}     ${col(band.leaf)}`,
    );
  }

  // ── Health & the flower lockout ─────────────────────────────────────────────
  const woodSick = woodAbove.filter(
    (c) => c.health < FLOWER_ANCHOR_HEALTH,
  ).length;
  const woodDry = woodAbove.filter((c) => c.health < 0.55).length; // at/near the dry-dormant floor
  const leafSick = leaves.filter((c) => c.health < 0.5).length;
  let flowerAnchors = 0;
  for (const c of woodAbove) {
    if (c.health <= FLOWER_ANCHOR_HEALTH) continue;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nq = c.q + dq,
        nr = c.r + dr;
      if (nr >= surfaceR(nq)) continue;
      const n = cells.get(hexKey(nq, nr));
      if (!n || n.type === "leaf") {
        flowerAnchors++;
        break;
      }
    }
  }
  out.push(`\n── Health & flowering ──`);
  line(
    "Wood below flower-anchor (0.6)",
    `${woodSick} / ${woodAbove.length}  (${pct(woodSick, woodAbove.length)}) — too dry to bloom on`,
  );
  line(
    "Wood dry/dormant (~0.5 floor)",
    `${woodDry}  (dry wood idles at half-health; it re-greens when watered, never dies of thirst)`,
  );
  line(
    "Leaves graying (<0.5 health)",
    `${leafSick} / ${leaves.length}  (${pct(leafSick, leaves.length)})`,
  );
  line(
    "Healthy flower anchors",
    `${flowerAnchors}  ${flowerAnchors === 0 ? "← can plant 0 flowers right now" : ""}`,
  );

  // ── Energy ──────────────────────────────────────────────────────────────────
  let banked = 0;
  for (const c of cells.values()) {
    if (
      c.type === "tree" ||
      c.type === "reinforced wood" ||
      c.type === "leaf" ||
      c.type === "flower" ||
      c.type === "fruit"
    )
      banked += c.energy;
  }
  const cap = living * CELL_ENERGY_CAP;
  out.push(`\n── Energy ──`);
  line("Banked (planning budget)", `${banked.toFixed(0)}`);
  line(
    "Storage ceiling (living×10)",
    `${cap}  → ${pct(banked, cap)} full ${banked > 0.9 * cap ? "⚠️  near cap, income is being WASTED" : ""}`,
  );

  // ── Roots ─────────────────────────────────────────────────────────────────
  let maxDepth = 0,
    waterTableRoots = 0;
  for (const c of roots) {
    const depth = c.r - surfaceR(c.q);
    if (depth > maxDepth) maxDepth = depth;
    if (depth >= 18) waterTableRoots++;
  }
  // Roots sitting next to a ground-water pocket — each is a drought-proof, infinite supply.
  let springRoots = 0;
  for (const c of roots) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      if (cells.get(hexKey(c.q + dq, c.r + dr))?.type === "ground water") {
        springRoots++;
        break;
      }
    }
  }
  out.push(`\n── Roots ──`);
  line(
    "Max depth / water-table roots",
    `${maxDepth} deep · ${waterTableRoots} at the table (≥18)`,
  );
  line(
    "Roots tapping ground water",
    `${springRoots}  ${springRoots > 0 ? "(infinite supply — drought-proof)" : ""}`,
  );

  // ── Structure ───────────────────────────────────────────────────────────────
  const { stress } = computeStructure(cells);
  let maxStress = 0,
    atRisk = 0;
  for (const s of stress.values()) {
    if (s > maxStress) maxStress = s;
    if (s > STRESS_WARN) atRisk++;
  }
  out.push(`\n── Structure ──`);
  line(
    "Max stress / cells at risk",
    `${maxStress.toFixed(2)} · ${atRisk} over ${STRESS_WARN}`,
  );

  // ── Verdict ─────────────────────────────────────────────────────────────────
  // Smarter than the old "no flag → balanced": a tree can be quietly dying (canopy
  // graying, vertical water gradient, low overall health) with none of the four hard
  // flags tripping. Lead with the health headline and refuse to call it balanced
  // unless living health is genuinely good.
  out.push(`\n── Verdict ──`);
  const notes: string[] = [];
  if (overallHealth < 0.5)
    notes.push(
      `In decline — average living-cell health is ${overallHealth.toFixed(2)}. The tree is losing tissue; act this season.`,
    );
  if (demand > 0 && supply < demand)
    notes.push(
      `Under-watered: canopy wants ${demand.toFixed(0)}/tick, trunks cap at ${supply.toFixed(0)}/tick. Thin the canopy or widen trunks.`,
    );
  // Vertical water gradient: a top band much drier than the base = canopy lifted past
  // what the trunk can conduct (the classic tall-tree failure the bands now expose).
  const topW = bandAvgWater(getBand(bandsHighToLow[0])),
    baseW = bandAvgWater(getBand(bandsHighToLow[bandsHighToLow.length - 1]));
  if (
    bandsHighToLow.length >= 2 &&
    isFinite(topW) &&
    isFinite(baseW) &&
    topW < WOOD_WATER_OK &&
    baseW > topW + 1.5
  )
    notes.push(
      `Canopy starves with height: water averages ${topW.toFixed(1)} at the top vs ${baseW.toFixed(1)} at the base. Widen the trunk (more conduction) or don't build so tall.`,
    );
  if (leaves.length > 0 && leafSick > leaves.length * 0.25)
    notes.push(
      `${pct(leafSick, leaves.length)} of leaves are graying (health < 0.5) — starved of water or energy and about to drop.`,
    );
  if (leaves.length > 0 && parasites > leaves.length * 0.25)
    notes.push(
      `${pct(parasites, leaves.length)} of leaves are net-negative (shaded). They drain water for no gain — prune them.`,
    );
  if (flowerAnchors === 0 && game.season === "spring")
    notes.push(
      `No healthy flower anchors — wood health < 0.6 everywhere a bloom could go. Fix water first.`,
    );
  if (banked > 0.9 * cap)
    notes.push(
      `Energy is capped (${pct(banked, cap)}) — you're wasting income. Spend on flowers (spring) or growth.`,
    );
  if (notes.length === 0)
    notes.push(
      overallHealth >= 0.75
        ? `No dominant problem flagged — tree looks healthy (avg living health ${overallHealth.toFixed(2)}).`
        : `No single hard flag, but average living health is only ${overallHealth.toFixed(2)} — the tree is stressed. Check the vertical profile and water above.`,
    );
  notes.forEach((n, i) => out.push(`  ${i + 1}. ${n}`));
  out.push("");

  return out.join("\n");
}
