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
  createPlanningState, handleTap, applySeasonAdvance, resolvableShedKeys, bankedEnergy, getValidPlacements, SPRING_VIGOR,
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
  // Mirror the app: spring budget is floored by the tree's vigor.
  const banked = bankedEnergy(game.cells)
  const budget = game.season === 'spring' ? Math.max(banked, SPRING_VIGOR) : banked
  const pl = plan(game, createPlanningState(budget))
  const shed = resolvableShedKeys(game, pl)
  const committed = applySeasonAdvance(game, pl)
  const frames = simulateSeason(committed, mulberry32(committed.rngSeed), w, shed)
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

function plant(game: GameState, pl: ReturnType<typeof createPlanningState>): ReturnType<typeof createPlanningState> {
  if (game.season === 'spring' && game.year === 1) {
    for (const [q, r, m] of [
      [0, 1, 'branch'], [0, 2, 'branch'], [0, -1, 'branch'], [0, -2, 'branch'],
      [-1, -2, 'leaf'], [1, -3, 'leaf'], [0, -3, 'leaf'],
    ] as [number, number, 'branch' | 'leaf'][]) {
      const res = handleTap(q, r, m, game, pl)
      if (res.kind === 'placed') pl = res.planning!
    }
    return pl
  }
  return pl
}

// Shed every leaf at the start of fall (the strategy the game's milestone instructs).
function shedAllLeaves(game: GameState, pl: ReturnType<typeof createPlanningState>) {
  for (const c of game.cells.values()) {
    if (c.type === 'leaf') {
      const res = handleTap(c.q, c.r, 'leaf', game, pl)
      if (res.kind === 'shed_toggled') pl = res.planning!
    }
  }
  return pl
}

// Play 12 seasons re-leafing each spring; `fallSheds` toggles whether leaves are
// shed at the start of fall. Returns the three recorded winter banked-energy totals.
function playThreeYears(fallSheds: boolean): { winterBanks: number[]; alive: boolean } {
  let game = seedState()
  const winterBanks: number[] = []
  for (let i = 0; i < 12; i++) {
    game = advance(game, (g, pl) => {
      if (g.season === 'spring' && g.year === 1) return plant(g, pl)
      if (g.season === 'spring') return reLeaf(g, pl)
      if (g.season === 'fall' && fallSheds) return shedAllLeaves(g, pl)
      return pl
    })
    if (game.season === 'winter') winterBanks.push(bankedEnergy(game.cells))
  }
  return { winterBanks, alive: [...game.cells.values()].some((c) => c.type === 'tree') }
}

describe('multi-year deciduous recovery', () => {
  it('keeping leaves through fall: winter reserves grow year over year (no spiral)', () => {
    const { winterBanks, alive } = playThreeYears(false)
    expect(winterBanks.length).toBe(3)
    for (const b of winterBanks) expect(b).toBeGreaterThan(2)
    expect(winterBanks[1]).toBeGreaterThan(winterBanks[0])
    expect(winterBanks[2]).toBeGreaterThan(winterBanks[1])
    expect(alive).toBe(true)
  })

  it('a tree starved toward 0 energy can still recover via the spring vigor floor', () => {
    // Build ONLY wood in spring Y1 (no leaves) — the classic new-player trap. With no
    // photosynthesis the tree drains down and, leafless, can't afford the 1 energy a leaf
    // costs without the floor. Re-leafing each spring (funded by the vigor floor) must pull
    // it back to positive, snowballing production. (Since wood upkeep dropped to 0.005 the
    // drain is gentle — the tree leans on the floor rather than hitting an exact 0, but the
    // recovery story is the same: it depends on the floor, then climbs well past it.)
    let game = seedState()
    let leanedOnFloor = false
    let recovered = false

    for (let i = 0; i < 8; i++) {
      game = advance(game, (g, pl) => {
        if (g.season === 'spring' && g.year === 1) {
          for (const [q, r] of [[0, 1], [0, 2], [0, -1], [0, -2]] as [number, number][]) {
            const res = handleTap(q, r, 'branch', g, pl)
            if (res.kind === 'placed') pl = res.planning!
          }
          return pl
        }
        if (g.season === 'spring') return reLeaf(g, pl)
        return pl
      })
      if (bankedEnergy(game.cells) <= SPRING_VIGOR) leanedOnFloor = true
      if (leanedOnFloor && bankedEnergy(game.cells) > SPRING_VIGOR + 2) recovered = true
    }

    expect(leanedOnFloor).toBe(true)  // it really did drain to where only the floor saved it
    expect(recovered).toBe(true)      // …and climbed back out, banking well past the floor
    expect([...game.cells.values()].some((c) => c.type === 'tree')).toBe(true)  // still alive
  })

  it('shedding at the start of fall (the instructed strategy) also thrives', () => {
    // Regression: shedding used to drop leaves BEFORE fall ran, forfeiting fall's
    // photosynthesis and starving the tree to a permanent 0-energy dead end. Now shed
    // leaves work through fall and resorb at season end, so this path grows too.
    const { winterBanks, alive } = playThreeYears(true)
    expect(winterBanks.length).toBe(3)
    for (const b of winterBanks) expect(b).toBeGreaterThan(5)
    expect(winterBanks[2]).toBeGreaterThan(winterBanks[0])
    expect(alive).toBe(true)
  })
})
