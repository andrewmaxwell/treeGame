import { GROUND_WATER_CAP, type Cell } from "./cells";
import { hexKey } from "./grid";

// Surface r-coordinate at axial column q.
// +r is downward, so this is how far "down" the surface is.
// Three overlapping sines give gentle bumps of ±2–3 cells.
export function surfaceR(q: number): number {
  return Math.round(
    1.5 * Math.sin(q * 0.13) +
      0.8 * Math.sin(q * 0.31) +
      0.5 * Math.sin(q * 0.67),
  );
}

// Deterministic hash for (q, r, seed) → [0, 1).
// Each input is XOR'd in then fully avalanched before the next, so no linear
// correlation survives across the (q, r) plane.
function hash2d(q: number, r: number, seed: number): number {
  // Start from seed
  let h = Math.imul(seed ^ 0xdeadbeef, 0x9e3779b9);
  h ^= h >>> 16;
  // Mix q
  h ^= q | 0;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  // Mix r
  h ^= r | 0;
  h = Math.imul(h, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 0x100000000;
}

// Rock density rises smoothly with depth via a logistic curve (no step/wall).
// Tuned so the deep asymptote and the old band midpoints roughly match the
// previous step function (depth 10 ≈ 0.10, 20 ≈ 0.22, 30 ≈ 0.34, deep → 0.45),
// keeping overall rock frequency about the same while the gradient is now
// continuous — the player can always push a bit deeper before hitting a wall.
const ROCK_MAX = 0.45; // deep asymptotic density
const ROCK_MID_DEPTH = 20; // depth at which density reaches half of ROCK_MAX
const ROCK_STEEPNESS = 0.125; // how sharply density ramps with depth

const rockProbability = (depth: number): number =>
  ROCK_MAX / (1 + Math.exp(-ROCK_STEEPNESS * (depth - ROCK_MID_DEPTH)));

const groundWaterProbability = (depth: number): number =>
  depth >= 100 ? 0.001 : 0;

// Lazily generates terrain cells on demand.
// Cells above the surface return null (air).
// Each (q, r) is generated at most once; results are cached.
export class TerrainGen {
  private readonly cache = new Map<string, Cell | null>();

  get(q: number, r: number): Cell | null {
    const key = hexKey(q, r);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const cell = this.generate(q, r);
    this.cache.set(key, cell);
    return cell;
  }

  private generate(q: number, r: number): Cell | null {
    const sr = surfaceR(q);
    if (r < sr) return null; // above the surface → air

    const depth = r - sr;
    const isRock = hash2d(q, r, 1) < rockProbability(depth);
    const isGroundWater = hash2d(q, r, 1) < groundWaterProbability(depth);

    if (isGroundWater) {
      return {
        q,
        r,
        type: "ground water",
        water: GROUND_WATER_CAP,
        energy: 0,
        health: 1,
        rot: 0,
        age: 0,
      };
    }

    if (isRock) {
      return {
        q,
        r,
        type: "rock",
        water: 0,
        energy: 0,
        health: 1,
        rot: 0,
        age: 0,
      };
    }

    // Soil: base moisture 8 ± 2 (well within the 20-unit cap)
    const water = 8 + (hash2d(q, r, 2) - 0.5) * 4;
    return { q, r, type: "soil", water, energy: 0, health: 1, rot: 0, age: 0 };
  }
}
