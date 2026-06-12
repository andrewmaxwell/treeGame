export type CellType = 'tree' | 'leaf' | 'flower' | 'fruit' | 'deadwood' | 'soil' | 'rock'

export interface Cell {
  q: number
  r: number
  type: CellType
  water: number    // 0 to capacity
  energy: number   // 0 to capacity
  health: number   // 0.0–1.0
  rot: number      // 0.0–1.0
  age: number      // seasons alive
  staged?: boolean
}

export const SOIL_WATER_CAP = 20
export const CELL_WATER_CAP = 10
export const CELL_ENERGY_CAP = 10

// Nutrient resorption: the fraction of a leaf's stored energy recovered into the
// tree when the leaf leaves the canopy. Deliberately asymmetric — shedding in fall
// (planned) recovers most of it; letting the winter frost take a leaf you never shed
// recovers only a little. This makes the canopy a *recoverable* energy store, so a
// tree that produced well in summer can re-leaf in spring instead of starving.
export const LEAF_SHED_RESORB = 0.75   // fall planning shed
export const LEAF_FROST_RESORB = 0.3   // winter-onset drop
