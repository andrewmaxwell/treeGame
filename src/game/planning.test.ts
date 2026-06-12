import { describe, it, expect } from 'vitest'
import {
  createPlanningState,
  handleTap,
  applySeasonAdvance,
  bankedEnergy,
  type PlanningState,
} from './planning'
import { hexKey } from '../sim/grid'
import { TerrainGen, surfaceR } from '../sim/terrain'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeState(cells: Cell[]): GameState {
  const map = new Map<string, Cell>()
  for (const c of cells) map.set(hexKey(c.q, c.r), c)
  return {
    cells: map,
    terrain: new TerrainGen(),
    season: 'spring',
    year: 1,
    score: 0,
    rngSeed: 42,
    worldSeed: 99,
  }
}

function mkCell(
  q: number, r: number, type: Cell['type'],
  opts: { water?: number; energy?: number } = {},
): Cell {
  return {
    q, r, type,
    water:  opts.water  ?? 5,
    energy: opts.energy ?? 5,
    health: 1, rot: 0, age: 0,
  }
}

// Stage a cell via handleTap and assert it succeeded.
function stage(q: number, r: number, mode: 'branch' | 'leaf', game: GameState, p: PlanningState): PlanningState {
  const result = handleTap(q, r, mode, game, p)
  expect(result.kind).toBe('placed')
  return result.planning!
}

// ─── budget enforcement ───────────────────────────────────────────────────────

describe('handleTap — energy budget', () => {
  it('rejects a placement that would exceed a fractional budget', () => {
    // surfaceR(0) = 0; the seed sits at (0,0). Budget 1.5: one cell fits, two don't.
    const game = makeState([mkCell(0, 0, 'tree')])
    let p = createPlanningState(1.5)
    p = stage(0, -1, 'branch', game, p)
    const second = handleTap(0, -2, 'branch', game, p)
    expect(second.kind).toBe('rejected_energy')  // 1 + 1 = 2 > 1.5
  })
})

// ─── season advance: energy accounting ────────────────────────────────────────

describe('applySeasonAdvance — energy economy', () => {
  it('deducts placement cost proportionally from pre-existing living cells', () => {
    // Seed with 8 energy; stage 2 cells (cost 2). After advance the seed should
    // hold 6 (8 × (1 − 2/8)) and each new cell 1 — total banked unchanged at 8.
    const game = makeState([mkCell(0, 0, 'tree', { energy: 8 })])
    let p = createPlanningState(8)
    p = stage(0, -1, 'branch', game, p)
    p = stage(0, -2, 'branch', game, p)

    const after = applySeasonAdvance(game, p)
    expect(after.cells.get(hexKey(0, 0))!.energy).toBeCloseTo(6, 5)
    expect(after.cells.get(hexKey(0, -1))!.energy).toBe(1)
    expect(after.cells.get(hexKey(0, -2))!.energy).toBe(1)
    expect(bankedEnergy(after.cells)).toBeCloseTo(8, 5)
  })

  it('materializes the shed refund into surviving cells', () => {
    // Tree (energy 4) + leaf (energy 2) to shed. Resorption is proportional:
    // 0.75 × 2 = 1.5 refunded into the tree.
    const game = makeState([
      mkCell(0,  0, 'tree', { energy: 4 }),
      mkCell(0, -1, 'leaf', { energy: 2 }),
    ])
    let p = createPlanningState(6)
    const result = handleTap(0, -1, 'leaf', game, p)  // leaf mode on a real leaf → shed mark
    expect(result.kind).toBe('shed_toggled')
    p = result.planning!

    const after = applySeasonAdvance(game, p)
    expect(after.cells.has(hexKey(0, -1))).toBe(false)          // leaf dropped
    expect(after.cells.get(hexKey(0, 0))!.energy).toBeCloseTo(5.5, 5)  // +1.5 refund
  })

  it('staging a branch over a shed-marked leaf clears the mark; the branch survives advance', () => {
    const game = makeState([
      mkCell(0,  0, 'tree', { energy: 8 }),
      mkCell(0, -1, 'leaf', { energy: 2 }),
    ])
    let p = createPlanningState(10)
    p = handleTap(0, -1, 'leaf', game, p).planning!    // mark leaf for shedding
    p = stage(0, -1, 'branch', game, p)                // then stage a branch over it
    expect(p.shedMarked.size).toBe(0)                  // mark cleared
    expect(p.energySpent).toBeCloseTo(1, 5)            // −1.5 refund undone, +1 cost = net 1

    const after = applySeasonAdvance(game, p)
    const cell = after.cells.get(hexKey(0, -1))
    expect(cell).toBeDefined()
    expect(cell!.type).toBe('tree')                    // staged branch survived
    expect(cell!.staged).toBeUndefined()               // staged flag fully dropped
  })

  it('never drives payer energy negative even if payers hold less than the cost', () => {
    // Seed holds 1 energy but the budget (set at planning start) was higher.
    const game = makeState([mkCell(0, 0, 'tree', { energy: 1 })])
    let p = createPlanningState(3)
    p = stage(0, -1, 'branch', game, p)
    p = stage(0, -2, 'branch', game, p)
    p = stage(1, -1, 'branch', game, p)

    const after = applySeasonAdvance(game, p)
    expect(after.cells.get(hexKey(0, 0))!.energy).toBeGreaterThanOrEqual(0)
  })

  it('advances season and year correctly', () => {
    const game = { ...makeState([mkCell(0, 0, 'tree')]), season: 'winter' as const, year: 3 }
    const after = applySeasonAdvance(game, createPlanningState(5))
    expect(after.season).toBe('spring')
    expect(after.year).toBe(4)
  })
})

// sanity: surfaceR(0) must be 0 for the coordinates used above
describe('test assumptions', () => {
  it('surfaceR(0) === 0', () => {
    expect(surfaceR(0)).toBe(0)
  })
})
