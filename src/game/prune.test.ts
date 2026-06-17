import { describe, it, expect } from 'vitest'
import {
  computeRemovalSet, pruneCost, seversWholeCanopy, PRUNE_COST,
  computeMultiRemoval, pruneSelectionCost, removesEntireTree,
} from './prune'
import { hexKey } from '../sim/grid'
import { surfaceR } from '../sim/terrain'
import type { Cell } from '../sim/cells'

function cells(list: Cell[]): Map<string, Cell> {
  const m = new Map<string, Cell>()
  for (const c of list) m.set(hexKey(c.q, c.r), c)
  return m
}

function c(q: number, r: number, type: Cell['type'] = 'tree', over: Partial<Cell> = {}): Cell {
  return { q, r, type, water: 5, energy: 5, health: 1, rot: 0, age: 1, ...over }
}

describe('computeRemovalSet', () => {
  // surfaceR(0) = 0, so r >= 0 is underground. A vertical trunk: root (0,0),
  // trunk (0,-1), (0,-2), leaf (0,-3).
  it('pruning a mid-trunk cell removes everything above it', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2), c(0, -3, 'leaf')])
    const removed = computeRemovalSet(m, hexKey(0, -1))
    expect(removed).toEqual(new Set([hexKey(0, -1), hexKey(0, -2), hexKey(0, -3)]))
  })

  it('pruning a leaf removes only the leaf', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2, 'leaf')])
    const removed = computeRemovalSet(m, hexKey(0, -2))
    expect(removed).toEqual(new Set([hexKey(0, -2)]))
  })

  it('redundant support: pruning one of two parallel roots orphans nothing else', () => {
    // Two underground roots (0,1) and (-1,1) are adjacent to each other and both
    // support the crown cell (0,0); a leaf sits on top at (0,-1). surfaceR(0)=0 and
    // surfaceR(-1)=-1, so both roots and (0,0) are underground.
    const m = cells([
      c(0, 1), c(-1, 1),   // two redundant roots (adjacent)
      c(0, 0),             // crown, touches both roots
      c(0, -1, 'leaf'),    // leaf on the crown
    ])
    const removed = computeRemovalSet(m, hexKey(0, 1))
    expect(removed).toEqual(new Set([hexKey(0, 1)]))  // only the pruned root
    expect(removed.has(hexKey(0, 0))).toBe(false)     // crown still grounded
    expect(removed.has(hexKey(0, -1))).toBe(false)    // leaf survives
  })

  it('deadwood conducts support (counts as wood)', () => {
    const m = cells([c(0, 0), c(0, -1, 'deadwood'), c(0, -2)])
    // Pruning the deadwood disconnects the cell above it.
    const removed = computeRemovalSet(m, hexKey(0, -1))
    expect(removed.has(hexKey(0, -2))).toBe(true)
  })

  it('returns empty for a missing target', () => {
    const m = cells([c(0, 0)])
    expect(computeRemovalSet(m, hexKey(9, 9)).size).toBe(0)
  })
})

describe('computeMultiRemoval', () => {
  it('unions each selection plus everything it disconnects, in one pass', () => {
    // Trunk: root (0,0) → (0,-1) → (0,-2) → leaf (0,-3); plus a side branch (1,-1).
    const m = cells([c(0, 0), c(0, -1), c(0, -2), c(0, -3, 'leaf'), c(1, -1)])
    // Selecting (0,-2) and the side branch (1,-1): (0,-2) drops the leaf above it too.
    const removed = computeMultiRemoval(m, new Set([hexKey(0, -2), hexKey(1, -1)]))
    expect(removed).toEqual(new Set([hexKey(0, -2), hexKey(0, -3), hexKey(1, -1)]))
  })

  it('ignores keys not present and returns empty for an empty selection', () => {
    const m = cells([c(0, 0), c(0, -1)])
    expect(computeMultiRemoval(m, new Set([hexKey(9, 9)])).size).toBe(0)
    expect(computeMultiRemoval(m, new Set()).size).toBe(0)
  })
})

describe('pruneSelectionCost', () => {
  it('sums the per-cell cost of only the selected cells (not collateral)', () => {
    // Two healthy selected cells = 2× PRUNE_COST; the disconnected leaf isn't charged.
    const m = cells([c(0, 0), c(0, -1, 'tree', { health: 1 }), c(0, -2, 'leaf')])
    const cost = pruneSelectionCost(m, new Set([hexKey(0, 0), hexKey(0, -1)]))
    expect(cost).toBe(2 * PRUNE_COST)
  })

  it('dead/dying selections are free', () => {
    const m = cells([c(0, 0, 'deadwood'), c(0, -1, 'tree', { health: 0.1 })])
    expect(pruneSelectionCost(m, new Set([hexKey(0, 0), hexKey(0, -1)]))).toBe(0)
  })
})

describe('removesEntireTree', () => {
  it('true when the removal covers every living cell (the single-seed case)', () => {
    const m = cells([c(0, 0)])  // one cell = the seed
    expect(removesEntireTree(m, computeRemovalSet(m, hexKey(0, 0)))).toBe(true)
  })

  it('true when pruning the only trunk takes the whole tree with it', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2, 'leaf')])
    expect(removesEntireTree(m, computeRemovalSet(m, hexKey(0, 0)))).toBe(true)
  })

  it('false when some living cell survives', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2, 'leaf')])
    expect(removesEntireTree(m, computeRemovalSet(m, hexKey(0, -2)))).toBe(false)  // just the leaf
  })

  it('ignores deadwood (it is not living)', () => {
    const m = cells([c(0, 0), c(0, -1, 'deadwood')])
    expect(removesEntireTree(m, new Set([hexKey(0, 0)]))).toBe(true)  // only living cell removed
  })
})

describe('pruneCost', () => {
  it('healthy wood costs PRUNE_COST', () => {
    expect(pruneCost(c(0, -1, 'tree', { health: 1 }))).toBe(PRUNE_COST)
  })
  it('dying / deadwood / rotted wood is free', () => {
    expect(pruneCost(c(0, -1, 'tree', { health: 0.2 }))).toBe(0)
    expect(pruneCost(c(0, -1, 'deadwood'))).toBe(0)
    expect(pruneCost(c(0, -1, 'tree', { rot: 0.5 }))).toBe(0)
  })
})

describe('seversWholeCanopy', () => {
  it('true when every above-ground cell is in the removal set', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2, 'leaf')])  // surfaceR(0)=0
    const removed = computeRemovalSet(m, hexKey(0, -1)) // removes both above-ground cells
    expect(seversWholeCanopy(m, removed)).toBe(true)
  })

  it('false when some canopy survives', () => {
    const m = cells([c(0, 0), c(0, -1), c(1, -1), c(0, -2, 'leaf')])
    const removed = computeRemovalSet(m, hexKey(0, -2)) // just the leaf
    expect(seversWholeCanopy(m, removed)).toBe(false)
  })

  it('ignores the underground root system', () => {
    expect(surfaceR(0)).toBe(0)
  })
})
