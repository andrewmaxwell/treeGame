// Multi-year deciduous-recovery guard. The death-spiral bug: after the winter
// leaf-drop a tree could fall to 0 banked energy and never afford a leaf again —
// permanent zombie stasis. This test plays a sensible tree (re-leaf each spring,
// keep leaves through fall) and asserts its winter reserves GROW year over year.
import { describe, it, expect } from 'vitest'
import { simulateSeason } from '../sim/simulate'
import { mulberry32 } from '../sim/rng'
import { generateWeather } from '../sim/weather'
import { hexKey } from '../sim/grid'
import { TerrainGen } from '../sim/terrain'
import {
  createPlanningState, handleTap, applySeasonAdvance, bankedEnergy, getValidPlacements,
} from './planning'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

function seedState(): GameState {
  const cells = new Map<string, Cell>()
  cells.set(hexKey(0, 0), { q: 0, r: 0, type: 'tree', water: 5, energy: 8, health: 1, rot: 0, age: 0 })
  return { cells, terrain: new TerrainGen(), season: 'spring', year: 1, score: 0, rngSeed: 1234, worldSeed: 1, goals: { completed: [], peakCells: 1 } }
}

function advance(game: GameState, plan: (g: GameState, p: ReturnType<typeof createPlanningState>) => ReturnType<typeof createPlanningState>): GameState {
  const w = generateWeather(game.season, game.year, game.worldSeed)
  const pl = plan(game, createPlanningState(bankedEnergy(game.cells)))
  const committed = applySeasonAdvance(game, pl)
  const frames = simulateSeason(committed, mulberry32(committed.rngSeed), w)
  return frames[frames.length - 1]
}

function reLeaf(game: GameState, pl: ReturnType<typeof createPlanningState>) {
  const budget = bankedEnergy(game.cells)
  const spots = [...getValidPlacements('leaf', game, pl)]
    .filter(([, t]) => t === 'leaf')
    .map(([k]) => k.split(',').map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1])
  const want = Math.max(1, Math.floor(budget) - 1)
  let placed = 0
  for (const [q, r] of spots) {
    if (placed >= want) break
    const res = handleTap(q, r, 'leaf', game, pl)
    if (res.kind === 'placed') { pl = res.planning!; placed++ }
  }
  return pl
}

describe('multi-year deciduous recovery', () => {
  it('a re-leafing tree grows its winter reserves year over year (no death spiral)', () => {
    let game = seedState()
    const winterBanks: number[] = []

    for (let i = 0; i < 12; i++) {
      game = advance(game, (g, pl) => {
        if (g.season === 'spring' && g.year === 1) {
          // Initial skeleton: roots, trunk, a few leaves.
          for (const [q, r, m] of [
            [0, 1, 'branch'], [0, 2, 'branch'], [0, -1, 'branch'], [0, -2, 'branch'],
            [-1, -2, 'leaf'], [1, -3, 'leaf'], [0, -3, 'leaf'],
          ] as [number, number, 'branch' | 'leaf'][]) {
            const res = handleTap(q, r, m, g, pl)
            if (res.kind === 'placed') pl = res.planning!
          }
          return pl
        }
        if (g.season === 'spring') return reLeaf(g, pl)
        return pl
      })

      if (game.season === 'winter') winterBanks.push(bankedEnergy(game.cells))
    }

    // Three winters recorded; each should be safely positive and trending UP — the
    // tree banks a surplus each year rather than spiralling to zero.
    expect(winterBanks.length).toBe(3)
    for (const b of winterBanks) expect(b).toBeGreaterThan(2)
    expect(winterBanks[1]).toBeGreaterThan(winterBanks[0])
    expect(winterBanks[2]).toBeGreaterThan(winterBanks[1])

    // And it ends the run alive with a real canopy re-grown after the last spring.
    expect([...game.cells.values()].some((c) => c.type === 'tree')).toBe(true)
  })
})
