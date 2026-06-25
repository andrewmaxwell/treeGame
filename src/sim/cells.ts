export type CellType =
  | "tree"
  | "leaf"
  | "flower"
  | "fruit"
  | "deadwood"
  | "reinforced wood"
  | "ground water"
  | "soil"
  | "rock";

export interface Cell {
  q: number; // Hex Grid Coordinate. Horizontal Axis
  r: number; // Hex Grid Coordinate. Diagonal Axis (60 degree offset)
  type: CellType;
  water: number; // 0 to capacity
  energy: number; // 0 to capacity
  health: number; // 0.0–1.0
  rot: number; // 0.0–1.0
  age: number; // seasons alive
  maturity?: number; // fruit only: 0.0–1.0 ripeness; ≥1 ripens to a seed, ≤0 aborts
  staged?: boolean;
}

export const GROUND_WATER_CAP = 200;
export const SOIL_WATER_CAP = 20;
export const CELL_WATER_CAP = 10;
export const CELL_ENERGY_CAP = 10;

// Nutrient resorption: the fraction of a leaf's stored energy recovered into the
// tree when the leaf leaves the canopy. Deliberately asymmetric — shedding in fall
// (planned) recovers most of it; letting the winter frost take a leaf you never shed
// recovers only a little. This makes the canopy a *recoverable* energy store, so a
// tree that produced well in summer can re-leaf in spring instead of starving.
export const LEAF_SHED_RESORB = 0.75; // fall planning shed
export const LEAF_FROST_RESORB = 0.3; // winter-onset drop

// ─── Reproductive cycle (Milestone 9) ──────────────────────────────────────────
// A flower sets to fruit at spring's end only if its health cleared this bar (a weak
// spring tree blooms but loses the flowers to drop — the first filter).
export const FLOWER_SET_HEALTH = 0.5;
// A new fruit starts here, leaving room to fall (abort) before reaching ripeness.
export const FRUIT_START_MATURITY = 0.15;
// Per-tick maturity change, gated by the fruit's own water (transpiration is fierce in
// summer). Well-fed it ripens; thirsty it visibly regresses; abort at ≤0, ripen at ≥1.
export const FRUIT_FED_WATER = 2; // water ≥ this → ripening
export const FRUIT_THIRSTY_WATER = 1; // water < this → regressing
export const FRUIT_RIPEN_RATE = 0.025; // +maturity/tick when fed
export const FRUIT_DECLINE_RATE = 0.04; // −maturity/tick when thirsty (faster than it builds)
export const FRUIT_RIPE = 1.0; // maturity at which a fruit is harvestable
