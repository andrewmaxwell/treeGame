import type { Cell } from "../sim/cells";
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP } from "../sim/cells";
import { surfaceR } from "../sim/terrain";

// Soil is by far the most-drawn cell when zoomed out (the whole underground field), and
// its colour depends only on moisture. Memoize it across a fixed set of moisture buckets
// so the per-frame terrain pass does ~64 lerpColor computations instead of one per visible
// soil hex. 64 buckets is visually continuous (the ramp spans <60 grey-levels of change).
const SOIL_BUCKETS = 64;
const soilColorCache: (string | undefined)[] = new Array(SOIL_BUCKETS + 1);
function soilColor(water: number): string {
  const t = Math.max(0, Math.min(1, water / SOIL_WATER_CAP));
  const b = Math.round(t * SOIL_BUCKETS);
  return (soilColorCache[b] ??= lerpColor(
    "#C4A46B",
    "#8B6340",
    b / SOIL_BUCKETS,
  ));
}

export function cellColor(cell: Cell): string {
  switch (cell.type) {
    case "soil":
      return soilColor(cell.water);
    case "rock":
      return "#6B6B6B";
    case "tree": {
      const base = cell.r >= surfaceR(cell.q) ? "#5C3A1A" : "#7B5230";
      const c = energyTint(
        waterTint(base, cell.water, CELL_WATER_CAP),
        cell.energy,
      );
      return healthTint(c, cell.health);
    }
    case "leaf": {
      const c = energyTint(
        waterTint("#4CAF50", cell.water, CELL_WATER_CAP),
        cell.energy,
      );
      return healthTint(c, cell.health);
    }
    case "flower":
      return healthTint("#FFAAB0", cell.health);
    case "fruit": {
      // Ramp from green-tinged (unripe) to orange-red (ripe) by maturity, so a fruit's
      // progress reads at a glance during the summer-carry playback.
      const m = Math.max(0, Math.min(1, cell.maturity ?? 1));
      return healthTint(lerpColor("#9CCC65", "#E8703A", m), cell.health);
    }
    case "deadwood":
      return "#8B7355";
    case "ground water":
      return "rgb(0, 95, 204)";
    case "reinforced wood":
      return "#4e2b00";
    default:
      return "rgb(0, 0, 0)";
  }
}

// Shift toward warm amber with stored energy. Subtle (≤15%): water (blue) reads as
// the dominant resource; blue + amber at full health lands near the warm base brown.
function energyTint(base: string, energy: number): string {
  const t = Math.max(0, Math.min(1, energy / CELL_ENERGY_CAP));
  return lerpColor(base, "#D4A017", t * 0.15);
}

// Below 0.5 health, desaturate toward gray so a dying limb visibly grays out before
// it dies. (At health 0 the cell has already converted to deadwood / dropped.)
function healthTint(base: string, health: number): string {
  if (health >= 0.5) return base;
  const t = Math.max(0, Math.min(1, (0.5 - health) / 0.5));
  return lerpColor(base, "#9E9E9E", t);
}

// Blend base color toward blue at full hydration; toward gray when dry.
function waterTint(base: string, water: number, cap: number): string {
  const t = Math.max(0, Math.min(1, water / cap));
  let color = lerpColor(base, "#4A90D9", t * 0.2);
  if (water <= 0) color = lerpColor(color, "#888888", 0.3);
  return color;
}

// ─── Resource-flow overlay (water / energy heatmap) ─────────────────────────────
// A toggleable view that recolours every cell by how full it is of a resource, so the
// player can see water climb the trunk and energy pool in the canopy — and read at a
// glance which limbs are thirsty or starved (playtest: "more visibility into how
// resources travel"). `level` is 0–1 (cell value / capacity).
export type ResourceOverlay = "none" | "water" | "energy";

// Water: dry (dark warm grey) → mid blue → full bright cyan.
// Energy: empty (dark) → amber → full bright gold.
// Two-stop ramp so the low and high ends are both distinct.
export function overlayColor(level: number, kind: "water" | "energy"): string {
  const t = Math.max(0, Math.min(1, level));
  if (kind === "water") {
    return t < 0.5
      ? lerpColor("#3a2f2f", "#1f6f9e", t * 2)
      : lerpColor("#1f6f9e", "#46d8ff", (t - 0.5) * 2);
  }
  return t < 0.5
    ? lerpColor("#2e2a1c", "#c79016", t * 2)
    : lerpColor("#c79016", "#ffe14a", (t - 0.5) * 2);
}

function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseColor(a);
  const [r2, g2, b2] = parseColor(b);
  return `rgb(${lerp(r1, r2, t)},${lerp(g1, g2, t)},${lerp(b1, b2, t)})`;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// Accepts both '#rrggbb' and 'rgb(r,g,b)' so tints can be chained (each tint
// returns an 'rgb(...)' string that the next tint must be able to re-parse).
function parseColor(c: string): [number, number, number] {
  if (c[0] === "#") {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/-?\d+/g)!;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
