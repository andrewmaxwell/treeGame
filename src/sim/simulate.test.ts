import { describe, it, expect } from 'vitest'
import {
  diffuseWater,
  diffuseEnergy,
  computeLight,
  photosynthesize,
  updateHealth,
  simulateSeason,
  runSeason,
} from './simulate'
import { mulberry32 } from './rng'
import { generateWeather, TICKS_PER_SEASON, type SeasonWeather, type StormSeverity } from './weather'
import { hexKey } from './grid'
import { TerrainGen, surfaceR } from './terrain'
import type { GameState } from '../game/state'
import type { Cell } from './cells'

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
    goals: { completed: [], peakCells: 1 },
  }
}

function cell(q: number, r: number, water: number, type: Cell['type'] = 'tree'): Cell {
  return { q, r, type, water, energy: 5, health: 1, rot: 0, age: 0 }
}

// Full control over energy and health, for the M5 energy/light/health tests.
function mkCell(
  q: number, r: number, type: Cell['type'],
  opts: { water?: number; energy?: number; health?: number } = {},
): Cell {
  return {
    q, r, type,
    water:  opts.water  ?? 5,
    energy: opts.energy ?? 5,
    health: opts.health ?? 1,
    rot: 0, age: 0,
  }
}

// ─── flow cap test ────────────────────────────────────────────────────────────

describe('diffuseWater — flow cap', () => {
  it('single high-water cell draining to 4 neighbours loses at most 2 units', () => {
    // Center cell (water=10) surrounded by 4 empty cells (water=0).
    // All cells are above ground (r << 0), so no soil involvement.
    // The center's outflow budget is 2.0; total outflow must not exceed that.
    const r = -10  // safely above ground for all q values
    const state = makeState([
      cell(0, r,     10),  // center: full
      cell(1, r,      0),  // right
      cell(-1, r,     0),  // left
      cell(0, r - 1,  0),  // upper-left-ish (in pointy-top, [0,-1])
      cell(0, r + 1,  0),  // lower neighbor — but this might be underground at r=-9
    ])
    const rng = mulberry32(0)
    const after = diffuseWater(state, rng)
    const centerKey = hexKey(0, r)
    const centerBefore = 10
    const centerAfter = after.cells.get(centerKey)!.water
    const lost = centerBefore - centerAfter
    expect(lost).toBeGreaterThan(0)
    expect(lost).toBeLessThanOrEqual(2.0 + 1e-9)
  })

  it('chain of three cells (10, 5, 0): flow from cell1→cell2 ≤ 2 per tick', () => {
    // Linear chain at r=-10: A(q=0)→B(q=1)→C(q=2)
    // HEX_NEIGHBORS for [1,0] means q+1 at same r is a neighbour.
    const r = -10
    const state = makeState([
      cell(0, r, 10),
      cell(1, r,  5),
      cell(2, r,  0),
    ])
    const rng = mulberry32(0)
    const after = diffuseWater(state, rng)
    const a = after.cells.get(hexKey(0, r))!.water
    const lost = 10 - a
    expect(lost).toBeGreaterThanOrEqual(0)
    expect(lost).toBeLessThanOrEqual(2.0 + 1e-9)
  })

  it('soil cell with water=15 adjacent to empty soil: flow ≤ 2 (cap triggered)', () => {
    // surfaceR(0) = 0, so soil cells at r >= 0 are underground.
    // Place two soil cells at r=1 (depth 1).
    const state = makeState([
      { ...cell(0, 1, 15, 'soil') },
      { ...cell(1, 1,  0, 'soil') },
    ])
    const rng = mulberry32(0)
    const after = diffuseWater(state, rng)
    const lost = 15 - after.cells.get(hexKey(0, 1))!.water
    // desired flow = 15 * 0.15 = 2.25 > 2.0 cap
    expect(lost).toBeCloseTo(2.0, 5)
  })
})

// ─── trunk width test ─────────────────────────────────────────────────────────

describe('diffuseWater — trunk width', () => {
  // Layout (all above ground at r = -10..-12):
  //   canopy leaf at (0, -12)
  //   1-wide trunk: single tree cell at (0, -11)
  //   root at (0, -10)
  //
  // For 2-wide:
  //   canopy leaf at (0, -12)
  //   trunk: (0, -11) AND (-1, -11)  — these are axial neighbours ([−1,0])
  //   roots: (0, -10) AND (-1, -10)

  function runTicks(state: GameState, ticks: number): GameState {
    const rng = mulberry32(12345)
    let s = state
    for (let i = 0; i < ticks; i++) s = diffuseWater(s, rng)
    return s
  }

  it('2-wide trunk delivers more water to canopy than 1-wide trunk over 5 ticks', () => {
    const CANOPY_START = 0
    const ROOT_WATER   = 9   // below cap, so gradient is meaningful
    const TRUNK_WATER  = 4

    const state1 = makeState([
      cell(0, -12, CANOPY_START, 'leaf'),   // canopy
      cell(0, -11, TRUNK_WATER,  'tree'),   // trunk (1-wide)
      cell(0, -10, ROOT_WATER,   'tree'),   // root
    ])

    const state2 = makeState([
      cell(0,  -12, CANOPY_START, 'leaf'),  // canopy
      cell(0,  -11, TRUNK_WATER,  'tree'),  // trunk cell 1
      cell(-1, -11, TRUNK_WATER,  'tree'),  // trunk cell 2 (adjacent to cell 1 & canopy)
      cell(0,  -10, ROOT_WATER,   'tree'),  // root 1
      cell(-1, -10, ROOT_WATER,   'tree'),  // root 2
    ])

    const after1 = runTicks(state1, 5)
    const after2 = runTicks(state2, 5)

    const canopy1 = after1.cells.get(hexKey(0, -12))!.water
    const canopy2 = after2.cells.get(hexKey(0, -12))!.water

    // 2-wide trunk has 2× the throughput capacity → more water at canopy
    expect(canopy2).toBeGreaterThan(canopy1)
  })
})

// ─── light calculation ──────────────────────────────────────────────────────

describe('computeLight — occlusion', () => {
  it('three stacked cells receive 1.0, 0.65, 0.42 light levels', () => {
    // surfaceR(0) = 0, so r = -1..-3 are all above ground.
    const state = makeState([
      mkCell(0, -3, 'leaf'),  // highest → first to intercept
      mkCell(0, -2, 'leaf'),
      mkCell(0, -1, 'leaf'),  // lowest → most shaded
    ])
    const light = computeLight(state, 5)  // summer sun angle
    expect(light.get(hexKey(0, -3))!).toBeCloseTo(1.0, 4)
    expect(light.get(hexKey(0, -2))!).toBeCloseTo(0.65, 4)
    expect(light.get(hexKey(0, -1))!).toBeCloseTo(0.4225, 4)
  })

  it('an adjacent column casts no shadow on the stack', () => {
    const state = makeState([
      mkCell(0, -3, 'leaf'),
      mkCell(0, -2, 'leaf'),
      mkCell(0, -1, 'leaf'),
      mkCell(1, -2, 'leaf'),  // one column to the side
    ])
    const light = computeLight(state, 5)
    // Side cell is in its own ray → full light, unaffected by the q=0 stack.
    expect(light.get(hexKey(1, -2))!).toBeCloseTo(1.0, 4)
    // The stack is also unchanged by the side cell.
    expect(light.get(hexKey(0, -3))!).toBeCloseTo(1.0, 4)
    expect(light.get(hexKey(0, -1))!).toBeCloseTo(0.4225, 4)
  })
})

// ─── energy diffusion ──────────────────────────────────────────────────────

describe('diffuseEnergy', () => {
  it('leaf (energy 10) → tree (energy 0): tree gains ~1.5 in one tick', () => {
    const state = makeState([
      mkCell(0, -11, 'leaf', { energy: 10 }),
      mkCell(0, -10, 'tree', { energy: 0 }),  // (0,-11)+[0,1] = (0,-10): adjacent
    ])
    const after = diffuseEnergy(state, mulberry32(0))
    const tree = after.cells.get(hexKey(0, -10))!.energy
    expect(tree).toBeCloseTo(1.5, 5)  // 10 × 0.15, under the 2.0 cap
  })

  it('adjacent leaves do not exchange energy directly (terminals route through wood)', () => {
    const state = makeState([
      mkCell(0, -11, 'leaf', { energy: 10 }),
      mkCell(0, -10, 'leaf', { energy: 0 }),
    ])
    const after = diffuseEnergy(state, mulberry32(0))
    expect(after.cells.get(hexKey(0, -10))!.energy).toBe(0)
  })

  it('deadwood between a leaf and a tree blocks energy transfer entirely', () => {
    const state = makeState([
      mkCell(0, -12, 'leaf',     { energy: 10 }),
      mkCell(0, -11, 'deadwood', { energy: 0 }),  // inert: no energy flow
      mkCell(0, -10, 'tree',     { energy: 0 }),
    ])
    const after = diffuseEnergy(state, mulberry32(0))
    // Leaf and tree are not adjacent; deadwood carries no energy → tree gets nothing.
    expect(after.cells.get(hexKey(0, -10))!.energy).toBe(0)
  })
})

// ─── photosynthesis ──────────────────────────────────────────────────────────

describe('photosynthesize', () => {
  it('a fully lit leaf gains lightLevel × intensity × 0.12 energy', () => {
    const state = makeState([mkCell(0, -1, 'leaf', { energy: 0 })])
    const light = computeLight(state, 5)  // single leaf → lightLevel 1.0
    const after = photosynthesize(state, light, 1.0)
    expect(after.cells.get(hexKey(0, -1))!.energy).toBeCloseTo(0.12, 5)
  })
})

// ─── health update & deadwood conversion ─────────────────────────────────────

describe('updateHealth — decline (lerp)', () => {
  // The lerp (health += (target-health)*0.01) is intentionally slow and asymptotic
  // — CLAUDE.md's "slow drama". A fully-deprived cell declines monotonically and
  // converts to deadwood once it crosses ≤0.001 (≈690 ticks). NOTE: this cannot
  // hit ≤0.001 within 120 ticks (that would require linear decay); the lerp was the
  // chosen behavior, so this test asserts monotonic decline + eventual conversion.
  it('a resourceless cell declines monotonically toward 0', () => {
    let s = makeState([mkCell(0, -5, 'tree', { water: 0, energy: 0, health: 1 })])
    const key = hexKey(0, -5)
    let prev = 1
    for (let i = 0; i < 120; i++) {
      s = updateHealth(s)
      const h = s.cells.get(key)!.health
      expect(h).toBeLessThan(prev)  // strictly decreasing
      prev = h
    }
    expect(prev).toBeLessThan(0.35)   // ~0.30 after 120 ticks
    expect(prev).toBeGreaterThan(0)   // still alive — not a popped balloon
  })

  it('eventually converts a dead tree cell to deadwood', () => {
    let s = makeState([mkCell(0, -5, 'tree', { water: 0, energy: 0, health: 1 })])
    const key = hexKey(0, -5)
    for (let i = 0; i < 700; i++) s = updateHealth(s)
    const c = s.cells.get(key)!
    expect(c.type).toBe('deadwood')
    expect(c.energy).toBe(0)
  })

  it('a leaf at health 0 drops (removed) rather than becoming deadwood', () => {
    // Start just above the death threshold so one tick crosses it.
    let s = makeState([mkCell(0, -1, 'leaf', { water: 0, energy: 0, health: 0.001 })])
    const key = hexKey(0, -1)
    s = updateHealth(s)
    expect(s.cells.has(key)).toBe(false)
  })
})

describe('updateHealth — recovery', () => {
  it('a well-supplied cell trends toward 1.0, not falling', () => {
    let s = makeState([mkCell(0, -5, 'tree', { water: 5, energy: 5, health: 0.5 })])
    const key = hexKey(0, -5)
    let prev = 0.5
    for (let i = 0; i < 50; i++) {
      s = updateHealth(s)
      const h = s.cells.get(key)!.health
      expect(h).toBeGreaterThan(prev)  // strictly increasing toward target 1.0
      prev = h
    }
    expect(prev).toBeLessThan(1.0)     // asymptotic — never quite reaches 1.0
  })
})

// ─── winter onset frost (deciduous reset) ────────────────────────────────────

describe('simulateSeason — winter onset', () => {
  // A small tree whose cells have lived a season (age 1) plus a fresh winter graft.
  function winterTree(): Cell[] {
    return [
      { q: 0, r: 0,  type: 'tree', water: 5, energy: 5, health: 1, rot: 0, age: 2 },   // root
      { q: 0, r: -1, type: 'tree', water: 5, energy: 5, health: 1, rot: 0, age: 2 },   // trunk
      { q: 0, r: -2, type: 'leaf', water: 5, energy: 5, health: 1, rot: 0, age: 1 },   // overwintering leaf
      { q: 1, r: -1, type: 'tree', water: 5, energy: 5, health: 1, rot: 0, age: 0 },   // fresh winter graft
    ]
  }

  it('drops every leaf at the first winter tick', () => {
    const state = makeState(winterTree())
    const weather = generateWeather('winter', 3, 99)
    const frames = simulateSeason(state, mulberry32(1), weather)
    // The leaf is gone from the very first frame.
    expect(frames[0].cells.has(hexKey(0, -2))).toBe(false)
    expect(frames[frames.length - 1].cells.has(hexKey(0, -2))).toBe(false)
  })

  it('kills fresh (age-0) growth but spares established wood', () => {
    const state = makeState(winterTree())
    const weather = generateWeather('winter', 3, 99)
    const frames = simulateSeason(state, mulberry32(1), weather)
    const final = frames[frames.length - 1]
    expect(final.cells.has(hexKey(1, -1))).toBe(false)  // fresh graft frozen out
    expect(final.cells.get(hexKey(0, 0))?.type).toBe('tree')   // root survives
    expect(final.cells.get(hexKey(0, -1))?.type).toBe('tree')  // trunk survives
  })

  it('ages surviving cells by one season', () => {
    const state = makeState(winterTree())
    const weather = generateWeather('winter', 3, 99)
    const frames = simulateSeason(state, mulberry32(1), weather)
    const root = frames[frames.length - 1].cells.get(hexKey(0, 0))!
    expect(root.age).toBe(3)  // was 2
  })
})

// ─── fall shedding (resolves at season end) ──────────────────────────────────

describe('simulateSeason — fall shedding', () => {
  // Root + trunk + a leaf. Shedding the leaf should leave it in place all season
  // (so it photosynthesizes), then drop it in the final frame, resorbing energy back
  // into the tree — never removed early (which would forfeit the season's energy).
  function tree(): Cell[] {
    return [
      { q: 0, r: 0,  type: 'tree', water: 6, energy: 5, health: 1, rot: 0, age: 2 },
      { q: 0, r: -1, type: 'tree', water: 6, energy: 5, health: 1, rot: 0, age: 2 },
      { q: 0, r: -2, type: 'leaf', water: 6, energy: 5, health: 1, rot: 0, age: 1 },
    ]
  }

  it('keeps the shed leaf present until the final frame', () => {
    const state = makeState(tree())
    const weather = generateWeather('fall', 2, 99)
    const shed = new Set([hexKey(0, -2)])
    const frames = simulateSeason(state, mulberry32(3), weather, shed)
    // Present mid-season (still working), gone only at the end.
    expect(frames[30].cells.has(hexKey(0, -2))).toBe(true)
    expect(frames[frames.length - 1].cells.has(hexKey(0, -2))).toBe(false)
  })

  it('shedding in fall resorbs more energy than letting the autumn drop take the leaf', () => {
    const fallW = generateWeather('fall', 2, 99)
    const shedKey = new Set([hexKey(0, -2)])
    const last = (frames: GameState[]) => frames[frames.length - 1]
    const bank = (s: GameState) =>
      [...s.cells.values()].reduce((a, c) => a + (c.type === 'tree' ? c.energy : 0), 0)

    // The whole canopy now drops at fall's end either way (deciduous): shed-marked
    // leaves resorb 75%, the rest only 30%. Both leaves photosynthesise all fall first.
    const aFall = last(simulateSeason(makeState(tree()), mulberry32(3), fallW, shedKey))  // shed
    const bFall = last(simulateSeason(makeState(tree()), mulberry32(3), fallW))           // kept

    expect(aFall.cells.has(hexKey(0, -2))).toBe(false)  // canopy is bare entering winter
    expect(bFall.cells.has(hexKey(0, -2))).toBe(false)  // …whether shed or not
    // Higher resorption rate (0.75 vs 0.30) leaves more banked in the wood.
    expect(bank(aFall)).toBeGreaterThan(bank(bFall))
  })
})

// ─── storms (structural failure) ──────────────────────────────────────────────

describe('simulateSeason — storms', () => {
  // A clear, dry season carrying a single storm event of the given severity.
  function stormWeather(severity: StormSeverity): SeasonWeather {
    return {
      season: 'spring', year: 2, sunAngleDeg: 20, intensity: 0.7,
      rain: new Array(TICKS_PER_SEASON).fill(false), isDrought: false,
      storm: { startTick: 3, ticks: 2, severity },
    }
  }

  // Root + vertical trunk + a long horizontal cantilever far above ground (r=-5, so
  // above the surface for every q here). The one-sided bending moment makes the trunk
  // junction very over-stressed (well past the minor threshold) — easy storm bait.
  function cantilever(): Cell[] {
    const list: Cell[] = []
    for (let r = 0; r >= -5; r--) list.push(mkCell(0, r, 'tree'))      // root + trunk
    for (let q = 1; q <= 8; q++) list.push(mkCell(q, -5, 'tree'))      // long horizontal arm
    return list
  }

  it('a minor storm snaps an over-stressed cantilever and the orphaned wood falls', () => {
    const before = cantilever().length
    const { frames, storms } = runSeason(makeState(cantilever()), mulberry32(2), stormWeather('minor'))
    const woodLeft = [...frames[frames.length - 1].cells.values()].filter((c) => c.type === 'tree').length
    expect(storms.length).toBeGreaterThan(0)
    expect(storms.reduce((a, s) => a + s.cellsLost, 0)).toBeGreaterThan(0)
    expect(woodLeft).toBeLessThan(before)   // cells were lost to the wind
  })

  it('the root system always survives — a tree blows down, it is not uprooted', () => {
    const { frames } = runSeason(makeState(cantilever()), mulberry32(2), stormWeather('severe'))
    // (0,0) is underground (surfaceR(0)=0): roots never snap.
    expect(frames[frames.length - 1].cells.get(hexKey(0, 0))?.type).toBe('tree')
  })

  it('a sturdy compact tree shrugs off a minor storm (no breaks)', () => {
    const sturdy = [mkCell(0, 0, 'tree'), mkCell(0, -1, 'tree')]
    const { storms } = runSeason(makeState(sturdy), mulberry32(2), stormWeather('minor'))
    expect(storms.length).toBe(0)
  })
})

// ─── integration: transpiration suction ──────────────────────────────────────

describe('simulateSeason — transpiration suction (tick-order integration)', () => {
  // This is emergent from the tick order (metabolize BEFORE diffuse): a leaf's
  // transpiration depletes its water, steepening the gradient that pulls water up
  // the trunk from the roots and soil. If the tick order ever regresses (diffusion
  // before metabolism), the leaf would dry out and this assertion would fail.
  it('keeps a leaf watered from the soil over a full season', () => {
    // surfaceR(0) = 0. Root at (0,0) sits in soil; trunk + leaf rise above ground.
    expect(surfaceR(0)).toBe(0)
    const state = makeState([
      mkCell(0,  0, 'tree', { water: 5 }),   // root (underground, touches soil)
      mkCell(0, -1, 'tree', { water: 5 }),
      mkCell(0, -2, 'tree', { water: 5 }),
      mkCell(0, -3, 'tree', { water: 5 }),
      mkCell(0, -4, 'leaf', { water: 5 }),   // canopy
    ])
    const weather = generateWeather('spring', 1, 99)
    const frames = simulateSeason(state, mulberry32(7), weather)
    const final = frames[frames.length - 1]
    const leaf = final.cells.get(hexKey(0, -4))
    // A leaf transpiring 0.10/tick for 60 ticks would lose 6 units — more than its
    // starting 5 — so any leftover water proves it was resupplied from below.
    expect(leaf).toBeDefined()
    expect(leaf!.type).toBe('leaf')
    expect(leaf!.water).toBeGreaterThan(0)
  })
})
