// Multi-season economy integration test: seed → roots+trunk+leaves → 3 seasons.
// Guards the whole energy loop: planning costs are deducted (no energy minting),
// photosynthesis feeds the next budget, and a sensible starter tree stays alive.
import { describe, it, expect } from 'vitest'
import { simulateSeason } from '../sim/simulate'
import { mulberry32 } from '../sim/rng'
import { generateWeather } from '../sim/weather'
import { hexKey } from '../sim/grid'
import { TerrainGen } from '../sim/terrain'
import { createPlanningState, handleTap, applySeasonAdvance, bankedEnergy } from './planning'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

function seedState(): GameState {
  const cells = new Map<string, Cell>()
  cells.set(hexKey(0, 0), { q: 0, r: 0, type: 'tree', water: 5, energy: 8, health: 1, rot: 0, age: 0 })
  return { cells, terrain: new TerrainGen(), season: 'spring', seasonHalf: 0, year: 1, score: 0, rngSeed: 1234, worldSeed: 1, goals: { completed: [], peakCells: 1 } }
}

describe('multi-season economy sanity', () => {
  it('a sensible starter tree survives 3 seasons with a finite, positive budget', () => {
    let game = seedState()

    // Season 1 plan: root below, trunk above. Leaves auto-grow on the canopy during the
    // simulation now (the player only shapes wood), so the plan stages wood only.
    let p = createPlanningState(bankedEnergy(game.cells))
    expect(p.energyAvailable).toBe(8)
    for (const [q, r, mode] of [[0, 1, 'branch'], [0, -1, 'branch'], [0, -2, 'branch']] as const) {
      const res = handleTap(q, r, mode, game, p)
      expect(res.kind).toBe('placed')
      p = res.planning!
    }
    game = applySeasonAdvance(game, p)
    expect(bankedEnergy(game.cells)).toBeCloseTo(8, 5)  // cost deducted, no minting

    const budgets: number[] = []
    for (let s = 0; s < 3; s++) {
      const weather = generateWeather(game.season, game.year, game.worldSeed)
      const frames = simulateSeason(game, mulberry32(game.rngSeed + s), weather)
      game = frames[frames.length - 1]
      const budget = bankedEnergy(game.cells)
      budgets.push(budget)
      expect(Number.isFinite(budget)).toBe(true)
      expect(budget).toBeGreaterThanOrEqual(0)
      game = applySeasonAdvance(game, createPlanningState(budget))  // empty plan
    }

    // The simulated seasons are summer → fall → winter. During the growth seasons
    // the canopy banks a meaningful budget; by winter the deciduous leaf-drop +
    // dormancy legitimately leave the tree running on near-empty reserves (this is
    // the point of the annual rhythm — you must re-leaf each spring).
    const peak = Math.max(...budgets)
    expect(peak).toBeGreaterThan(2)                          // productive growth seasons
    expect(peak).toBeLessThanOrEqual(game.cells.size * 10)   // bounded by emergent max storage

    // And the woody skeleton survives winter on its reserves — not a popped balloon.
    const livingWood = [...game.cells.values()].filter((c) => c.type === 'tree').length
    expect(livingWood).toBeGreaterThan(0)
  })
})
