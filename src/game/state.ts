import type { Cell } from '../sim/cells'
import { TerrainGen, surfaceR } from '../sim/terrain'
import { hexKey } from '../sim/grid'

export type Season = 'spring' | 'summer' | 'fall' | 'winter'

// Milestone progress. `completed` holds milestone ids in completion order (drives
// the goal log); `peakCells` is the largest living-cell count ever reached (some
// milestones are "high-water-mark" goals that shouldn't un-complete when the tree
// shrinks back down over winter).
export interface GoalProgress {
  completed: string[]
  peakCells: number
}

export interface GameState {
  // Live game cells: tree, leaf, flower, fruit, deadwood.
  // Soil and rock are generated lazily by terrain; modified soil cells get
  // promoted into this map by the simulation so changes persist.
  cells: Map<string, Cell>
  terrain: TerrainGen
  season: Season
  year: number
  score: number
  rngSeed: number   // seed used to produce the NEXT season's RNG
  worldSeed: number // stable for the whole run; drives deterministic weather/forecast
  goals: GoalProgress
}

export function createInitialState(): GameState {
  const terrain = new TerrainGen()
  const cells = new Map<string, Cell>()

  const seedR = surfaceR(0)
  const seed: Cell = {
    q: 0, r: seedR,
    type: 'tree',
    water: 5,
    energy: 8,
    health: 1.0,
    rot: 0,
    age: 0,
  }
  cells.set(hexKey(0, seedR), seed)

  return {
    cells, terrain, season: 'spring', year: 1, score: 0,
    rngSeed: Math.floor(Math.random() * 0xFFFFFFFF),
    worldSeed: Math.floor(Math.random() * 0xFFFFFFFF),
    goals: { completed: [], peakCells: 1 },
  }
}
