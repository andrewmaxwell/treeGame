// Multi-season economy integration test: seed → roots+trunk+leaves → 3 seasons.
// Guards the whole energy loop: planning costs are deducted (no energy minting),
// photosynthesis feeds the next budget, and a sensible starter tree stays alive.
import { describe, it, expect } from 'vitest'
import { simulateSeason } from '../sim/simulate'
import { mulberry32 } from '../sim/rng'
import { hexKey } from '../sim/grid'
import { TerrainGen } from '../sim/terrain'
import { createPlanningState, handleTap, applySeasonAdvance, bankedEnergy } from './planning'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

function seedState(): GameState {
  const cells = new Map<string, Cell>()
  cells.set(hexKey(0, 0), { q: 0, r: 0, type: 'tree', water: 5, energy: 8, health: 1, rot: 0, age: 0 })
  return { cells, terrain: new TerrainGen(), season: 'spring', year: 1, score: 0, rngSeed: 1234 }
}

describe('multi-season economy sanity', () => {
  it('a sensible starter tree survives 3 seasons with a finite, positive budget', () => {
    let game = seedState()

    // Season 1 plan: root below, trunk above, leaves on top (the "natural first moves")
    let p = createPlanningState(bankedEnergy(game.cells))
    expect(p.energyAvailable).toBe(8)
    for (const [q, r, mode] of [[0, 1, 'branch'], [0, -1, 'branch'], [0, -2, 'branch'], [0, -3, 'leaf'], [1, -3, 'leaf']] as const) {
      const res = handleTap(q, r, mode, game, p)
      expect(res.kind).toBe('placed')
      p = res.planning!
    }
    game = applySeasonAdvance(game, p)
    expect(bankedEnergy(game.cells)).toBeCloseTo(8, 5)  // cost deducted, no minting

    const budgets: number[] = []
    for (let s = 0; s < 3; s++) {
      const frames = simulateSeason(game, mulberry32(game.rngSeed + s))
      game = frames[frames.length - 1]
      const budget = bankedEnergy(game.cells)
      budgets.push(budget)
      expect(Number.isFinite(budget)).toBe(true)
      expect(budget).toBeGreaterThanOrEqual(0)
      game = applySeasonAdvance(game, createPlanningState(budget))  // empty plan
    }

    // Tree should still be alive and producing: budget meaningfully positive,
    // and bounded by emergent max storage (living cells × 10 cap).
    expect(budgets[budgets.length - 1]).toBeGreaterThan(2)
    expect(budgets[budgets.length - 1]).toBeLessThanOrEqual(game.cells.size * 10)
  })
})
