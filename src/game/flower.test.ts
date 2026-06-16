import { describe, it, expect } from 'vitest'
import {
  createPlanningState, handleTap, applySeasonAdvance, getValidPlacements,
  canPlaceFlower, FLOWER_COST,
} from './planning'
import { hexKey } from '../sim/grid'
import { TerrainGen, surfaceR } from '../sim/terrain'
import type { GameState, Season } from './state'
import type { Cell } from '../sim/cells'

function mk(q: number, r: number, type: Cell['type'], opts: Partial<Cell> = {}): Cell {
  return { q, r, type, water: 5, energy: 5, health: 1, rot: 0, age: 0, ...opts }
}

// A vertical above-ground trunk on column 0, with its tip at (0, sr-2). surfaceR(0)=0.
function trunkState(season: Season = 'spring', tipHealth = 1): GameState {
  const sr = surfaceR(0)
  const cells = [
    mk(0, sr, 'tree'),            // surface/root anchor
    mk(0, sr - 1, 'tree'),
    mk(0, sr - 2, 'tree', { health: tipHealth }),  // branch tip
  ]
  const map = new Map<string, Cell>()
  for (const c of cells) map.set(hexKey(c.q, c.r), c)
  return {
    cells: map, terrain: new TerrainGen(), season, year: 1, score: 0,
    rngSeed: 42, worldSeed: 99, goals: { completed: [], peakCells: 30 },
  }
}

const TIP_ABOVE = { q: 0, r: surfaceR(0) - 3 }   // empty hex directly above the tip

describe('canPlaceFlower', () => {
  it('accepts an empty above-ground hex on a healthy spring branch tip', () => {
    const g = trunkState('spring')
    const p = createPlanningState(10)
    expect(canPlaceFlower(TIP_ABOVE.q, TIP_ABOVE.r, g, p)).toBe(true)
  })

  it('rejects outside spring', () => {
    const g = trunkState('summer')
    const p = createPlanningState(10)
    expect(canPlaceFlower(TIP_ABOVE.q, TIP_ABOVE.r, g, p)).toBe(false)
  })

  it('rejects when the anchoring tip is too sickly (health ≤ 0.6)', () => {
    const g = trunkState('spring', 0.5)
    const p = createPlanningState(10)
    expect(canPlaceFlower(TIP_ABOVE.q, TIP_ABOVE.r, g, p)).toBe(false)
  })

  it('allows a flower to replace a real leaf adjacent to healthy wood', () => {
    const g = trunkState('spring')
    const leaf = { q: TIP_ABOVE.q, r: TIP_ABOVE.r, type: 'leaf' as const, water: 5, energy: 5, health: 1, rot: 0, age: 0 }
    g.cells.set(hexKey(TIP_ABOVE.q, TIP_ABOVE.r), leaf)
    const p = createPlanningState(10)
    expect(canPlaceFlower(TIP_ABOVE.q, TIP_ABOVE.r, g, p)).toBe(true)
    const res = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p)
    expect(res.kind).toBe('placed')
    expect(res.planning!.stagedCells.get(hexKey(TIP_ABOVE.q, TIP_ABOVE.r))!.type).toBe('flower')
  })
})

describe('handleTap — flower mode', () => {
  it('stages a flower for 3 energy', () => {
    const g = trunkState('spring')
    let p = createPlanningState(10)
    const res = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p)
    expect(res.kind).toBe('placed')
    p = res.planning!
    expect(p.energyAvailable - p.energySpent).toBe(7)   // 10 − 3
    expect(p.stagedCells.get(hexKey(TIP_ABOVE.q, TIP_ABOVE.r))!.type).toBe('flower')
  })

  it('rejects a flower the tree cannot afford', () => {
    const g = trunkState('spring')
    const p = createPlanningState(2)   // < FLOWER_COST
    expect(handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p).kind).toBe('rejected_energy')
  })

  it('allows multiple blooms anchored to the same healthy wood', () => {
    const g = trunkState('spring')
    let p = createPlanningState(10)
    p = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p).planning!
    // (1, sr-3) is also adjacent to the healthy tip (0, sr-2) — the one-per-tip rule is
    // gone, so a second bloom here is allowed (cost is the only limiter).
    const second = handleTap(1, surfaceR(0) - 3, 'flower', g, p)
    expect(second.kind).toBe('placed')
  })

  it('unstaging a flower refunds the full 3 energy', () => {
    const g = trunkState('spring')
    let p = createPlanningState(10)
    p = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p).planning!
    p = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p).planning!   // tap again → unstage
    expect(p.energySpent).toBe(0)
    expect(p.stagedCells.size).toBe(0)
  })
})

describe('getValidPlacements — flower mode', () => {
  it('offers the tip hexes in spring and nothing out of season', () => {
    const p = createPlanningState(10)
    expect(getValidPlacements('flower', trunkState('spring'), p).size).toBeGreaterThan(0)
    expect(getValidPlacements('flower', trunkState('summer'), p).size).toBe(0)
  })
})

describe('applySeasonAdvance — flower cost', () => {
  it('deducts the flower cost from the tree at advance', () => {
    const g = trunkState('spring')
    let p = createPlanningState(15)
    p = handleTap(TIP_ABOVE.q, TIP_ABOVE.r, 'flower', g, p).planning!
    const committed = applySeasonAdvance(g, p)
    // The flower is now a real cell; net banked energy fell by ~FLOWER_COST (minus the
    // new flower's own starting energy of 1, which is part of the cost).
    const before = [...g.cells.values()].reduce((a, c) => a + c.energy, 0)
    const after = [...committed.cells.values()].reduce((a, c) => a + c.energy, 0)
    expect(before - after).toBeCloseTo(FLOWER_COST - 1)
  })
})
