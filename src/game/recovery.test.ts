// Multi-year deciduous-recovery guard. The canopy now AUTO-GROWS each spring (leaves are
// no longer hand-placed), so the death-spiral this once guarded — a leafless tree unable to
// afford the 1 energy a leaf cost — can't happen anymore: leaves are free and regrow on
// their own. These tests assert the positive story still holds: a tree that establishes wood
// and grows modestly sees its winter reserves climb year over year (the snowball), and even
// a wood-only plant (never touching the canopy) thrives because the canopy fills itself in.
import { describe, it, expect } from 'vitest'
import { simulateSeason } from '../sim/simulate'
import { mulberry32 } from '../sim/rng'
import { generateWeather } from '../sim/weather'
import { hexKey } from '../sim/grid'
import { TerrainGen, surfaceR } from '../sim/terrain'
import {
  createPlanningState, handleTap, applySeasonAdvance, bankedEnergy, SPRING_VIGOR,
  type PlanningState,
} from './planning'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

function seedState(): GameState {
  const cells = new Map<string, Cell>()
  cells.set(hexKey(0, 0), { q: 0, r: 0, type: 'tree', water: 5, energy: 8, health: 1, rot: 0, age: 0 })
  return { cells, terrain: new TerrainGen(), season: 'spring', year: 1, score: 0, rngSeed: 1234, worldSeed: 1, goals: { completed: [], peakCells: 1 } }
}

function advance(game: GameState, plan: (g: GameState, p: PlanningState) => PlanningState): GameState {
  const w = generateWeather(game.season, game.year, game.worldSeed)
  // Mirror the app: spring budget is floored by the tree's vigor (a wood-planting lifeline).
  const banked = bankedEnergy(game.cells)
  const budget = game.season === 'spring' ? Math.max(banked, SPRING_VIGOR) : banked
  const pl = plan(game, createPlanningState(budget))
  const committed = applySeasonAdvance(game, pl)
  const frames = simulateSeason(committed, mulberry32(committed.rngSeed), w)
  return frames[frames.length - 1]
}

// Stage a list of wood cells (leaves auto-grow, so plans only ever place wood).
function placeWood(game: GameState, pl: PlanningState, spots: [number, number][]): PlanningState {
  for (const [q, r] of spots) {
    const res = handleTap(q, r, 'branch', game, pl)
    if (res.kind === 'placed') pl = res.planning!
  }
  return pl
}

// Topmost trunk cell (smallest r) — the growing tip.
function trunkTop(game: GameState): { q: number; r: number } {
  let best = { q: 0, r: surfaceR(0) }
  for (const c of game.cells.values()) if (c.type === 'tree' && c.r < best.r) best = { q: c.q, r: c.r }
  return best
}

describe('multi-year deciduous recovery (auto-canopy)', () => {
  it('a growing tree banks more each winter, year over year (the snowball)', () => {
    let game = seedState()
    const winterBanks: number[] = []
    for (let i = 0; i < 12; i++) {
      game = advance(game, (g, pl) => {
        if (g.season !== 'spring') return pl
        if (g.year === 1) {
          // Establish: deep-ish roots + a starter trunk.
          return placeWood(g, pl, [[0, 1], [0, 2], [0, 3], [0, -1], [0, -2], [0, -3]])
        }
        // Each later spring, extend the trunk up one (the canopy auto-expands to match).
        const t = trunkTop(g)
        return placeWood(g, pl, [[t.q, t.r - 1]])
      })
      if (game.season === 'winter') winterBanks.push(bankedEnergy(game.cells))
    }
    expect(winterBanks.length).toBe(3)
    for (const b of winterBanks) expect(b).toBeGreaterThan(2)
    expect(winterBanks[1]).toBeGreaterThan(winterBanks[0])
    expect(winterBanks[2]).toBeGreaterThan(winterBanks[1])
    expect([...game.cells.values()].some((c) => c.type === 'tree')).toBe(true)
  })

  it('a wood-only plant still thrives — the canopy fills itself in', () => {
    // The classic new-player move: spend the seed's reserve on wood and never "grow leaves".
    // Once that was a softlock (couldn't afford a leaf); now the canopy auto-grows, so the
    // tree feeds itself and stays comfortably alive.
    let game = seedState()
    game = advance(game, (g, pl) =>
      g.season === 'spring' && g.year === 1
        ? placeWood(g, pl, [[0, 1], [0, 2], [0, -1], [0, -2]])
        : pl,
    )
    for (let i = 0; i < 11; i++) game = advance(game, (_g, pl) => pl)  // never plan again

    expect([...game.cells.values()].some((c) => c.type === 'tree')).toBe(true)
    expect(bankedEnergy(game.cells)).toBeGreaterThan(2)
  })
})
