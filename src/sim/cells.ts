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
