import { describe, it, expect } from 'vitest'
import { computeStructure, applyBreakage, STRESS_WARN } from './structure'
import { STORM_THRESHOLD } from './weather'
import { hexKey } from './grid'
import { surfaceR } from './terrain'
import type { Cell } from './cells'

// surfaceR(0) = 0, so r >= 0 is underground (root), r < 0 is above-ground wood.
function cells(list: Cell[]): Map<string, Cell> {
  const m = new Map<string, Cell>()
  for (const c of list) m.set(hexKey(c.q, c.r), c)
  return m
}
function c(q: number, r: number, type: Cell['type'] = 'tree'): Cell {
  return { q, r, type, water: 5, energy: 5, health: 1, rot: 0, age: 1 }
}

// ─── stress: balance-aware bending model ──────────────────────────────────────

describe('computeStructure — stress', () => {
  // Build a root + a horizontal arm of `n` cells reaching right at row r=-3.
  function cantilever(n: number): Map<string, Cell> {
    const list = [c(0, 0), c(0, -1), c(0, -2), c(0, -3)]
    for (let q = 1; q <= n; q++) list.push(c(q, -3))
    return cells(list)
  }

  it('a lone cell has the minimum strength of 3 and finite, low stress', () => {
    const s = computeStructure(cells([c(0, 0)]))
    expect(s.strength.get(hexKey(0, 0))!).toBe(3)
    expect(Number.isFinite(s.stress.get(hexKey(0, 0))!)).toBe(true)
    expect(s.stress.get(hexKey(0, 0))!).toBeLessThan(0.8)
  })

  it("a horizontal branch's stress is highest at its base and ~zero at the tip", () => {
    const s = computeStructure(cantilever(5))
    const base = s.stress.get(hexKey(1, -3))!   // attaches to the trunk
    const tip  = s.stress.get(hexKey(5, -3))!   // nothing hangs beyond it
    expect(base).toBeGreaterThan(tip)
    expect(tip).toBeLessThan(0.1)
  })

  it('a longer one-sided branch is more stressed than a shorter one', () => {
    const short = computeStructure(cantilever(3))
    const long  = computeStructure(cantilever(6))
    const maxOf = (m: Map<string, number>) => Math.max(...m.values())
    expect(maxOf(long.stress)).toBeGreaterThan(maxOf(short.stress))
  })

  it('balance matters: opposed arms cancel, a one-sided arm does not', () => {
    // Arms attach straight off the root (0,0) so there is no leaning trunk to confound
    // the comparison. Opposed arms put the load's centre of mass back over the base
    // (moment ≈ 0); a one-sided arm leaves it hanging out to the side (large moment).
    const balanced = computeStructure(cells([
      c(0, 0), c(1, 0), c(2, 0), c(3, 0), c(-1, 0), c(-2, 0), c(-3, 0),
    ]))
    const oneSided = computeStructure(cells([
      c(0, 0), c(1, 0), c(2, 0), c(3, 0),
    ]))
    expect(balanced.stress.get(hexKey(0, 0))!).toBeLessThan(oneSided.stress.get(hexKey(0, 0))!)
  })

  it('is local: thickening the trunk below never raises an upper cell\'s stress', () => {
    // The classic complaint — strengthen low, watch something high light up. In the
    // moment model an upper cell sees only the wood above it, so its stress is fixed.
    const thinBase = computeStructure(cantilever(5))
    const wideBase = computeStructure(new Map([
      ...cantilever(5),
      // Add girth low on the trunk (extra wood beside the roots/lower trunk).
      [hexKey(1, 0), c(1, 0)], [hexKey(-1, 0), c(-1, 0)], [hexKey(1, -1), c(1, -1)],
    ]))
    // Every arm cell's stress is unchanged by the lower-trunk girth.
    for (let q = 1; q <= 5; q++) {
      const k = hexKey(q, -3)
      expect(wideBase.stress.get(k)!).toBeCloseTo(thinBase.stress.get(k)!, 9)
    }
  })

  it('a thicker trunk is stronger (more cross-section) than a 1-wide one', () => {
    const thin = computeStructure(cells([c(0, 0), c(0, -1), c(0, -2)]))   // 1-wide trunk
    // Same trunk widened to 3 cells across at the middle row.
    const thick = computeStructure(cells([c(0, 0), c(-1, -1), c(0, -1), c(1, -1), c(0, -2)]))
    expect(thick.strength.get(hexKey(0, -1))!).toBeGreaterThan(thin.strength.get(hexKey(0, -1))!)
  })
})

// ─── connectivity after a break ───────────────────────────────────────────────

describe('applyBreakage', () => {
  it('snapping a mid-trunk cell drops everything it was holding up', () => {
    // root (0,0), trunk (0,-1), (0,-2), leaf (0,-3).
    const m = cells([c(0, 0), c(0, -1), c(0, -2), c(0, -3, 'leaf')])
    const removed = applyBreakage(m, new Set([hexKey(0, -1)]))
    expect(removed).toEqual(new Set([hexKey(0, -1), hexKey(0, -2), hexKey(0, -3)]))
  })

  it('leaves the root system intact when an outer twig snaps', () => {
    const m = cells([c(0, 0), c(0, -1), c(0, -2), c(0, -3, 'leaf')])
    const removed = applyBreakage(m, new Set([hexKey(0, -3)]))
    expect(removed).toEqual(new Set([hexKey(0, -3)]))  // only the leaf-tip
  })

  it('redundant support keeps the crown grounded when one of two roots snaps', () => {
    // Two adjacent roots both support the crown; snapping one orphans nothing.
    const m = cells([c(0, 1), c(-1, 1), c(0, 0), c(0, -1, 'leaf')])
    const removed = applyBreakage(m, new Set([hexKey(0, 1)]))
    expect(removed).toEqual(new Set([hexKey(0, 1)]))
  })
})

// ─── storm thresholds sanity ──────────────────────────────────────────────────

describe('storm thresholds', () => {
  it('severe storms break weaker cells than minor storms', () => {
    expect(STORM_THRESHOLD.severe).toBeLessThan(STORM_THRESHOLD.moderate)
    expect(STORM_THRESHOLD.moderate).toBeLessThan(STORM_THRESHOLD.minor)
    // The standing-warning tint line sits below even the gentlest storm's threshold,
    // so a reddened cell is a genuine "a storm could take this" signal.
    expect(STRESS_WARN).toBeLessThanOrEqual(STORM_THRESHOLD.minor)
  })

  it('surface convention holds (r ≥ 0 underground at q=0)', () => {
    expect(surfaceR(0)).toBe(0)
  })
})
