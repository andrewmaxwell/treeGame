import type { Cell, CellType } from './cells'
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP, LEAF_FROST_RESORB, LEAF_SHED_RESORB } from './cells'
import { hexKey, HEX_NEIGHBORS } from './grid'
import { surfaceR } from './terrain'
import type { RNG } from './rng'
import { mulberry32 } from './rng'
import type { SeasonWeather, StormSeverity } from './weather'
import { STORM_THRESHOLD } from './weather'
import { computeStructure, applyBreakage } from './structure'
import type { GameState } from '../game/state'

// ─── helpers ─────────────────────────────────────────────────────────────────

function waterCap(cell: Cell): number {
  return cell.type === 'soil' ? SOIL_WATER_CAP : CELL_WATER_CAP
}

function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q)
}

function isTerminalType(t: CellType): boolean {
  return t === 'leaf' || t === 'flower' || t === 'fruit'
}

function canExchangeWater(a: Cell, b: Cell): boolean {
  if (a.type === 'rock' || b.type === 'rock') return false
  if (a.type === 'soil' && b.type === 'soil') return true
  if (a.type === 'soil' && b.type === 'tree'     && isUnderground(b)) return true
  if (b.type === 'soil' && a.type === 'tree'     && isUnderground(a)) return true
  if (a.type === 'tree' && b.type === 'tree') return true
  if (a.type === 'tree' && isTerminalType(b.type)) return true
  if (b.type === 'tree' && isTerminalType(a.type)) return true
  if (a.type === 'deadwood' && (b.type === 'tree' || b.type === 'deadwood')) return true
  if (b.type === 'deadwood' && (a.type === 'tree' || a.type === 'deadwood')) return true
  return false
}

// Energy flows tree↔tree and tree↔terminal (leaf/flower/fruit) — never into soil,
// never terminal↔terminal (terminals route through wood, same as water), and never
// through deadwood (energetically inert, unlike its 0.3 capillary water flow).
function canExchangeEnergy(a: Cell, b: Cell): boolean {
  if (a.type === 'tree') return b.type === 'tree' || isTerminalType(b.type)
  if (b.type === 'tree') return isTerminalType(a.type)
  return false
}

// ─── soil pre-expansion ───────────────────────────────────────────────────────

// Build the season's working cell map: game cells + the soil region needed for
// root absorption and soil diffusion. Called ONCE per season in simulateSeason.
// Idempotent: if soil cells are already in state.cells (from a prior season),
// no new cells are added — the existing ones are just copied.
function buildWork(state: GameState): Map<string, Cell> {
  const work = new Map<string, Cell>()
  for (const [k, v] of state.cells) work.set(k, { ...v })

  // Layer 1: soil cells adjacent to underground tree/deadwood cells.
  // Track only the cells NEWLY added so layer-2 expansion stays bounded.
  const newInLayer1: Cell[] = []
  for (const cell of state.cells.values()) {
    if (cell.type !== 'tree' && cell.type !== 'deadwood') continue
    if (!isUnderground(cell)) continue
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const q = cell.q + dq, r = cell.r + dr
      const key = hexKey(q, r)
      if (work.has(key)) continue
      const tc = state.terrain.get(q, r)
      if (tc?.type === 'soil') {
        work.set(key, { ...tc })
        newInLayer1.push(work.get(key)!)
      }
    }
  }

  // Layer 2: one more ring of soil, for soil-soil diffusion near roots.
  // Expanding only from newInLayer1 keeps this O(roots), not O(all soil).
  for (const sc of newInLayer1) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const q = sc.q + dq, r = sc.r + dr
      const key = hexKey(q, r)
      if (work.has(key)) continue
      const tc = state.terrain.get(q, r)
      if (tc?.type === 'soil') work.set(key, { ...tc })
    }
  }

  // Top-surface soil rows near the tree — needed for rain/evaporation.
  // Use the q-range of TREE cells only (not soil, to keep the range stable).
  let qMin = Infinity, qMax = -Infinity
  for (const cell of state.cells.values()) {
    if (cell.type === 'soil' || cell.type === 'rock') continue
    if (cell.q < qMin) qMin = cell.q
    if (cell.q > qMax) qMax = cell.q
  }
  if (isFinite(qMin)) {
    for (let q = qMin - 3; q <= qMax + 3; q++) {
      const sr = surfaceR(q)
      for (let d = 0; d <= 2; d++) {
        const key = hexKey(q, sr + d)
        if (!work.has(key)) {
          const tc = state.terrain.get(q, sr + d)
          if (tc?.type === 'soil') work.set(key, { ...tc })
        }
      }
    }
  }

  return work
}

// ─── tick steps ───────────────────────────────────────────────────────────────

// Cloud cover during a rain event dims all incoming light to 40% (CLAUDE.md).
const CLOUD_LIGHT_MULT = 0.4
// Dormant winter metabolism: all consumption is heavily throttled so the bare,
// leafless tree can coast on reserves until spring.
const WINTER_METAB_MULT = 0.35
// Water a rain event deposits per tick into each of the top soil rows.
const RAIN_DEPOSIT = 0.3

const LIGHT_TYPES: ReadonlySet<CellType> = new Set<CellType>(['tree', 'leaf', 'flower', 'fruit'])

// Light calculation: returns lightLevel (0–1) for every above-ground absorbing
// cell, keyed by coordinate string. Pure — does not mutate any cell.
//
// The returned value is purely geometric (fraction of incident light reaching the
// cell after canopy occlusion). Season intensity is NOT applied here — it is applied
// at photosynthesis, so a single light map can serve any intensity.
export function computeLight(state: GameState, sunAngleDeg: number): Map<string, number> {
  const tanT = Math.tan((sunAngleDeg * Math.PI) / 180)

  // Gather above-ground absorbing cells and find the top row (smallest r).
  const absorbing: Cell[] = []
  let topRow = Infinity
  for (const cell of state.cells.values()) {
    if (!LIGHT_TYPES.has(cell.type)) continue
    if (cell.r >= surfaceR(cell.q)) continue  // at or below surface → no light
    absorbing.push(cell)
    if (cell.r < topRow) topRow = cell.r
  }

  // Group cells by sun-column key. A cell's pixel-x is hexSize·√3·(q + r/2), so its
  // column index (x divided by the column width hexSize·√3) is just q + r/2 — the
  // hexSize factor cancels. Projecting up a ray tilted θ from vertical shifts the
  // column the ray entered at the top by (r − topRow)·tanθ. Cells whose projected
  // column rounds to the same integer share a ray and shade one another.
  const groups = new Map<number, Cell[]>()
  for (const cell of absorbing) {
    const colKey = Math.round((cell.q + cell.r / 2) - (cell.r - topRow) * tanT)
    let g = groups.get(colKey)
    if (!g) { g = []; groups.set(colKey, g) }
    g.push(cell)
  }

  // Within each ray, walk top-down; each cell absorbs 35% of remaining light.
  // Air gaps don't reduce light (absent cells are simply not in the group).
  const light = new Map<string, number>()
  for (const g of groups.values()) {
    g.sort((a, b) => a.r - b.r)  // smallest r (highest) intercepts first
    let remaining = 1.0
    for (const cell of g) {
      light.set(hexKey(cell.q, cell.r), remaining)
      remaining *= 0.65
    }
  }
  return light
}

// Photosynthesis: leaf cells turn light into energy. Non-leaf cells receive energy
// only via diffusion — so canopy structure, not bulk, drives the energy economy.
export function photosynthesize(state: GameState, light: Map<string, number>, intensity: number): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'leaf') continue
    const ll = light.get(key)
    if (ll === undefined) continue
    const gain = ll * intensity * 0.12
    if (gain <= 0) continue
    work.set(key, { ...cell, energy: Math.min(cell.energy + gain, CELL_ENERGY_CAP) })
  }
  return { ...state, cells: work }
}

// Metabolism: per-tick water (transpiration) and energy consumption. Runs before
// diffusion so the leaf's depleted water steepens the gradient that pulls water up
// the tree — transpiration suction is emergent, not special-cased. `mult` scales
// all consumption (winter dormancy passes 0.5).
function metabolize(state: GameState, mult: number): GameState {
  const newCells = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    let w = 0, e = 0
    switch (cell.type) {
      case 'tree':   w = 0.05; e = 0.015; break
      case 'leaf':   w = 0.10; e = 0.02; break
      case 'flower': w = 0.15; e = 0.10; break
      case 'fruit':  w = 0.20; e = 0.05; break
    }
    if (w === 0 && e === 0) continue
    newCells.set(key, {
      ...cell,
      water:  Math.max(0, cell.water  - w * mult),
      energy: Math.max(0, cell.energy - e * mult),
    })
  }
  return { ...state, cells: newCells }
}

// Root absorption: underground tree cells pull water from adjacent soil cells.
// Soil cells are guaranteed to be present in state.cells by the pre-expansion.
export function absorbWater(state: GameState, rng: RNG): GameState {
  const work = new Map(state.cells)

  for (const cell of state.cells.values()) {
    if (cell.type !== 'tree') continue
    if (!isUnderground(cell)) continue

    const cellKey = hexKey(cell.q, cell.r)
    const soilNeighborKeys: string[] = []
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nKey = hexKey(cell.q + dq, cell.r + dr)
      if (work.get(nKey)?.type === 'soil') soilNeighborKeys.push(nKey)
    }

    // Shuffle to remove directional bias
    for (let i = soilNeighborKeys.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[soilNeighborKeys[i], soilNeighborKeys[j]] = [soilNeighborKeys[j], soilNeighborKeys[i]]
    }

    let inBudget = 2.0
    for (const nKey of soilNeighborKeys) {
      if (inBudget <= 0) break
      const soil = work.get(nKey)!
      const treeCell = work.get(cellKey)!
      const amount = Math.min(soil.water * 0.05, inBudget, CELL_WATER_CAP - treeCell.water, soil.water)
      if (amount <= 0) continue
      work.set(cellKey, { ...treeCell, water: treeCell.water + amount })
      work.set(nKey,    { ...soil,     water: soil.water    - amount })
      inBudget -= amount
    }
  }

  return { ...state, cells: work }
}

// Generic single-pass diffusion across adjacent exchangeable pairs. Both water and
// energy diffusion share this: same 0.15 flow rate, same shuffled-pair order, same
// per-cell in/out budget. The resource-specific bits are injected via `cfg`.
interface DiffuseConfig {
  get: (c: Cell) => number              // current amount of the resource
  set: (c: Cell, v: number) => Cell     // return a copy with the resource set to v
  canExchange: (a: Cell, b: Cell) => boolean
  capacity: (c: Cell) => number         // max the receiver can hold
  budget: (c: Cell) => number           // per-tick in/out cap for this cell
}

function diffuse(state: GameState, rng: RNG, cfg: DiffuseConfig): GameState {
  const work = new Map(state.cells)

  // Collect unique exchangeable pairs
  const seen = new Set<string>()
  const pairs: Array<[string, string]> = []
  for (const [keyA, cellA] of work) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const keyB = hexKey(cellA.q + dq, cellA.r + dr)
      if (!work.has(keyB)) continue
      const pairId = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`
      if (seen.has(pairId)) continue
      if (cfg.canExchange(cellA, work.get(keyB)!)) {
        seen.add(pairId)
        pairs.push([keyA, keyB])
      }
    }
  }

  // Fisher-Yates shuffle to remove directional bias
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j], pairs[i]]
  }

  // Per-cell inflow/outflow budgets for this tick
  const outBudget = new Map<string, number>()
  const inBudget  = new Map<string, number>()
  for (const [key, cell] of work) {
    const cap = cfg.budget(cell)
    outBudget.set(key, cap)
    inBudget.set(key, cap)
  }

  for (const [keyA, keyB] of pairs) {
    const diff = cfg.get(work.get(keyA)!) - cfg.get(work.get(keyB)!)
    if (Math.abs(diff) < 1e-9) continue

    const [sKey, rKey] = diff > 0 ? [keyA, keyB] : [keyB, keyA]
    const sender = work.get(sKey)!
    const recv   = work.get(rKey)!

    const flow = Math.min(
      Math.abs(diff) * 0.15,
      outBudget.get(sKey)!,
      inBudget.get(rKey)!,
      cfg.capacity(recv) - cfg.get(recv),
    )
    if (flow <= 0) continue

    work.set(sKey, cfg.set(sender, cfg.get(sender) - flow))
    work.set(rKey, cfg.set(recv,   cfg.get(recv)   + flow))
    outBudget.set(sKey, outBudget.get(sKey)! - flow)
    inBudget.set(rKey,  inBudget.get(rKey)!  - flow)
  }

  return { ...state, cells: work }
}

// Water diffusion: one pass across all valid adjacent pairs.
// Soil cells are present in state.cells; no terrain expansion needed here.
export function diffuseWater(state: GameState, rng: RNG): GameState {
  return diffuse(state, rng, {
    get: (c) => c.water,
    set: (c, v) => ({ ...c, water: v }),
    canExchange: canExchangeWater,
    capacity: waterCap,
    budget: (c) => (c.type === 'deadwood' ? 0.3 : 2.0),  // deadwood: capillary only
  })
}

// Energy diffusion: parallel to water, among tree/leaf/flower/fruit only. Deadwood
// has a budget of 0 (energetically inert) — and is excluded from pairs anyway.
export function diffuseEnergy(state: GameState, rng: RNG): GameState {
  return diffuse(state, rng, {
    get: (c) => c.energy,
    set: (c, v) => ({ ...c, energy: v }),
    canExchange: canExchangeEnergy,
    capacity: () => CELL_ENERGY_CAP,
    budget: (c) => (c.type === 'deadwood' ? 0 : 2.0),
  })
}

// Health update: each living cell's health lerps toward a target set by its
// water/energy supply. The lerp (not a fixed step) makes both decline and recovery
// gradual and slowing — trouble is visible long before death (CLAUDE.md "slow drama").
const DEATH_THRESHOLD = 0.001
export function updateHealth(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type === 'deadwood' || cell.type === 'soil' || cell.type === 'rock') continue

    const hasWater  = cell.water  > 3
    const hasEnergy = cell.energy > 2
    const target = hasWater && hasEnergy ? 1.0 : hasWater || hasEnergy ? 0.5 : 0.0

    const health = cell.health + (target - cell.health) * 0.01

    if (health <= DEATH_THRESHOLD) {
      if (cell.type === 'tree') {
        // Tree → deadwood: retains its water, energy zeroed, rot reset. Stays on map.
        work.set(key, { ...cell, type: 'deadwood', energy: 0, rot: 0, health: 0 })
      } else {
        // Leaf/flower/fruit drop entirely.
        work.delete(key)
      }
    } else {
      work.set(key, { ...cell, health })
    }
  }
  return { ...state, cells: work }
}

// Stub: rot spread (Milestone 9)
function spreadRot(state: GameState, _rng: RNG): GameState { return state }

// Storm structural-failure check (one storm tick). Every above-ground wood cell whose
// stress exceeds the storm's threshold has a 50% chance to snap (so identical trees
// don't always fail identically). Snapped wood plus everything it was holding up — no
// longer root-connected — falls. Roots (underground) don't snap: a tree blows down at
// the trunk, it isn't uprooted. Returns the new state and how many cells were lost.
function applyStorm(state: GameState, rng: RNG, severity: StormSeverity): { state: GameState; cellsLost: number } {
  const threshold = STORM_THRESHOLD[severity]
  const { stress } = computeStructure(state.cells)

  const snapped = new Set<string>()
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'tree' && cell.type !== 'deadwood') continue
    if (cell.r >= surfaceR(cell.q)) continue  // underground roots hold
    const s = stress.get(key)
    if (s !== undefined && s > threshold && rng() < 0.5) snapped.add(key)
  }
  if (snapped.size === 0) return { state, cellsLost: 0 }

  const removed = applyBreakage(state.cells, snapped)
  const work = new Map(state.cells)
  for (const k of removed) work.delete(k)
  return { state: { ...state, cells: work }, cellsLost: removed.size }
}

// Soil update: rain deposition, evaporation, and the deep water table.
// Rain falls only on rain ticks (into the top 3–4 rows); evaporation rate is
// seasonal and amplified by drought; the water table at depth ≥ 18 always regens.
function updateSoil(state: GameState, weather: SeasonWeather, tick: number): GameState {
  const work = new Map(state.cells)
  const raining = weather.rain[tick]
  const evapBase = weather.season === 'summer' ? 0.05 : 0.01
  const evap = evapBase * (weather.isDrought ? 1.5 : 1)

  for (const [key, cell] of state.cells) {
    if (cell.type !== 'soil') continue
    const depth = cell.r - surfaceR(cell.q)
    let w = cell.water

    if (depth <= 1) w = Math.max(0, w - evap)                       // evaporation: top 2 rows
    if (raining && depth <= 3) w = Math.min(SOIL_WATER_CAP, w + RAIN_DEPOSIT)  // rain: top 4 rows
    if (depth >= 18) w = Math.min(SOIL_WATER_CAP, w + 0.1)          // water table

    if (w !== cell.water) work.set(key, { ...cell, water: w })
  }
  return { ...state, cells: work }
}

// Winter onset (first tick of winter): kills any growth placed during the winter
// planning phase (age 0). The canopy itself normally came down at fall's end (see
// resolveAutumnDrop), so entering winter the tree is already bare — but this stays a
// backstop: any leaf/flower/fruit still present at winter onset drops here too (a leaf
// resorbing the low frost fraction).
function winterFrost(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type === 'leaf' || cell.type === 'flower' || cell.type === 'fruit') {
      if (cell.type === 'leaf') depositResorb(work, cell, cell.energy * LEAF_FROST_RESORB)
      work.delete(key)
    } else if (cell.type === 'tree' && cell.age === 0) {
      work.delete(key)
    }
  }
  return { ...state, cells: work }
}

// Distribute `amount` energy evenly into the tree cells adjacent to a dropping leaf,
// clamped to capacity (overflow is lost). Mutates `work` in place.
function depositResorb(work: Map<string, Cell>, leaf: Cell, amount: number): void {
  if (amount <= 0) return
  const treeKeys: string[] = []
  for (const [dq, dr] of HEX_NEIGHBORS) {
    const nk = hexKey(leaf.q + dq, leaf.r + dr)
    if (work.get(nk)?.type === 'tree') treeKeys.push(nk)
  }
  if (treeKeys.length === 0) return
  const share = amount / treeKeys.length
  for (const nk of treeKeys) {
    const t = work.get(nk)!
    work.set(nk, { ...t, energy: Math.min(CELL_ENERGY_CAP, t.energy + share) })
  }
}

// Resolve shedding at SEASON END for a NON-fall season: each still-present shed leaf
// resorbs most of its energy (LEAF_SHED_RESORB) back into the tree, then drops. (Marking
// leaves outside fall is unusual but allowed.) Because this runs after the last tick,
// shed leaves photosynthesize the whole season first.
function resolveShedding(state: GameState, shedKeys: Set<string>): GameState {
  if (shedKeys.size === 0) return state
  const work = new Map(state.cells)
  for (const key of shedKeys) {
    const cell = work.get(key)
    if (cell?.type !== 'leaf') continue  // already died/dropped during the season
    depositResorb(work, cell, cell.energy * LEAF_SHED_RESORB)
    work.delete(key)
  }
  return { ...state, cells: work }
}

// The deciduous drop, resolved at the END of FALL: the WHOLE canopy comes down. Leaves
// the player marked to shed resorb LEAF_SHED_RESORB (75%); the rest resorb only
// LEAF_FROST_RESORB (30%) — so shedding is always the better play, and now visibly so.
// Either way the leaves photosynthesized all fall first (this runs after the last tick).
//
// Crucially the canopy drops HERE, entering winter, not at winter's first tick. So the
// winter planning budget already reflects the tree's true overwintering reserves — no
// phantom leaf energy that is about to vanish to frost (which read like a bug: "13 in
// winter, 3 in spring"). Winter is now honestly a bare-tree, live-on-reserves season.
function resolveAutumnDrop(state: GameState, shedKeys: Set<string>): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'leaf') continue
    const rate = shedKeys.has(key) ? LEAF_SHED_RESORB : LEAF_FROST_RESORB
    depositResorb(work, cell, cell.energy * rate)
    work.delete(key)
  }
  return { ...state, cells: work }
}

// Age every living cell (and deadwood) by one season. Runs once, after the last
// tick, so a cell committed this season enters its first winter still at age 0.
function ageCells(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type === 'soil' || cell.type === 'rock') continue
    work.set(key, { ...cell, age: cell.age + 1 })
  }
  return { ...state, cells: work }
}

// ─── tick & season ────────────────────────────────────────────────────────────

// A storm break recorded during playback: which frame it landed on, how many cells
// fell, and the severity (for the highlight banner + summary line).
export interface StormBreak {
  frame: number
  cellsLost: number
  severity: StormSeverity
}

interface TickResult {
  state: GameState
  break?: { cellsLost: number; severity: StormSeverity }
}

function runTick(state: GameState, rng: RNG, weather: SeasonWeather, tick: number): TickResult {
  let s = state
  // Winter onset frost happens before anything else on the first tick.
  if (tick === 0 && weather.season === 'winter') s = winterFrost(s)

  const raining = weather.rain[tick]
  const light = computeLight(s, weather.sunAngleDeg)
  const intensity = weather.intensity * (raining ? CLOUD_LIGHT_MULT : 1)
  s = photosynthesize(s, light, intensity)

  const metabMult = weather.season === 'winter' ? WINTER_METAB_MULT : 1
  s = metabolize(s, metabMult)
  s = absorbWater(s, rng)
  s = diffuseWater(s, rng)
  s = diffuseEnergy(s, rng)
  s = updateHealth(s)
  s = spreadRot(s, rng)
  s = updateSoil(s, weather, tick)

  // Event check (tick order step 10): storm structural failure on its event ticks.
  let brk: TickResult['break']
  const storm = weather.storm
  if (storm && tick >= storm.startTick && tick < storm.startTick + storm.ticks) {
    const r = applyStorm(s, rng, storm.severity)
    s = r.state
    if (r.cellsLost > 0) brk = { cellsLost: r.cellsLost, severity: storm.severity }
  }

  return { state: s, break: brk }
}

// One simulated season: a GameState snapshot per tick plus the storm breaks that
// occurred (for the playback highlight + summary). Soil is pre-expanded once so tick
// functions never query terrain themselves. At season end, shed leaves resorb + drop,
// then surviving cells age one season — both folded into the final frame.
export interface SeasonPlayback {
  frames: GameState[]
  storms: StormBreak[]
}

const NO_SHED: ReadonlySet<string> = new Set()
export function runSeason(
  state: GameState, rng: RNG, weather: SeasonWeather, shedKeys: ReadonlySet<string> = NO_SHED,
): SeasonPlayback {
  let cur: GameState = { ...state, cells: buildWork(state) }
  const frames: GameState[] = []
  const storms: StormBreak[] = []
  const ticks = weather.rain.length
  for (let tick = 0; tick < ticks; tick++) {
    const res = runTick(cur, rng, weather, tick)
    cur = res.state
    frames.push(cur)
    if (res.break) storms.push({ frame: tick, ...res.break })
  }
  if (frames.length > 0) {
    // Fall: the whole canopy drops (deciduous). Any other season: only stray shed marks.
    let last = weather.season === 'fall'
      ? resolveAutumnDrop(frames[frames.length - 1], shedKeys as Set<string>)
      : resolveShedding(frames[frames.length - 1], shedKeys as Set<string>)
    last = ageCells(last)
    frames[frames.length - 1] = last
  }
  return { frames, storms }
}

// Frames-only convenience wrapper — the shape the simulation tests assert against.
export function simulateSeason(
  state: GameState, rng: RNG, weather: SeasonWeather, shedKeys: ReadonlySet<string> = NO_SHED,
): GameState[] {
  return runSeason(state, rng, weather, shedKeys).frames
}

export { mulberry32 }
