import type { Cell, CellType } from './cells'
import {
  CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP, LEAF_FROST_RESORB, LEAF_SHED_RESORB,
  FLOWER_SET_HEALTH, FRUIT_START_MATURITY, FRUIT_FED_WATER, FRUIT_THIRSTY_WATER,
  FRUIT_RIPEN_RATE, FRUIT_DECLINE_RATE, FRUIT_RIPE,
} from './cells'
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

// Energy a leaf generates per tick = remaining_light × season_intensity × PHOTO_COEFF ×
// heightLightFactor. PHOTO_COEFF was raised 0.12 → 0.24: at 0.12 a leaf shaded even
// modestly (and most of a canopy self-shades at 35% absorption/cell) netted barely above
// its 0.02 upkeep, so a normal tree never banked the surplus that flowering needs — every
// playthrough collapsed to a 0-energy, health-0.5 "zombie" that could not set fruit.
export const PHOTO_COEFF = 0.24

// Lifted leaves catch more sun than ground-hugging ones. This is the REASON to grow tall:
// without it, sprawling a flat mat along the surface (no self-shading, every leaf in full
// sun, short water paths) was a dominant exploit — a ground-crawler scored ~4× a normal
// tree in the harness and never died. A leaf at the surface gets LIGHT_GROUND_FACTOR of
// its light; full value is reached LIGHT_FULL_HEIGHT cells up. So height now trades off
// against the trunk throughput needed to water a tall canopy — the intended core loop.
// Retuned 0.40 → 0.22 alongside the wood-upkeep drop (see metabolize). With wood upkeep
// now near-zero, a flat ground-hugging sprawl (the crawler) became cheap again and needed
// a firmer light penalty to stay suppressed; 0.22 keeps the crawler the worst strategy
// while a mid-height balanced canopy (height 5–7 → factor 0.6–0.76) is barely affected.
export const LIGHT_GROUND_FACTOR = 0.22
export const LIGHT_FULL_HEIGHT = 10
function heightLightFactor(q: number, r: number): number {
  const h = surfaceR(q) - r  // cells above the surface
  if (h <= 0) return LIGHT_GROUND_FACTOR
  return Math.min(1, LIGHT_GROUND_FACTOR + (h / LIGHT_FULL_HEIGHT) * (1 - LIGHT_GROUND_FACTOR))
}

// Stomatal regulation: a water-stressed leaf/fruit closes its stomata, throttling
// transpiration so it stops bleeding water it doesn't have. The factor is 1 when the cell
// holds ≥ STOMA_FULL water and ramps down to STOMA_MIN as water → 0. This lets a canopy
// stabilise at low-but-alive water under drought (demand falls as supply falls) instead of
// transpiring itself to 0 and dropping — softening the cliff where a tall canopy had no
// drought counterplay (deep roots don't help: the deep water is consumed climbing the trunk
// and the water table depletes). STOMA_FULL = 2 (not 3) so only genuinely dry cells throttle
// — a normally-watered canopy (water 3–9) is untouched. Deliberately NOT applied to
// photosynthesis: coupling carbon to leaf water starves recovering trees (whose small canopy
// runs lowish on water), breaking the recovery snowball — energy income stays light-driven.
export const STOMA_FULL = 2
export const STOMA_MIN = 0.15
export function stomataFactor(water: number): number {
  if (water >= STOMA_FULL) return 1
  return STOMA_MIN + (1 - STOMA_MIN) * (water / STOMA_FULL)
}

// Leaf energy upkeep per tick (see metabolize), and the margin a hex's light income must
// clear for an auto-grown leaf to be worth it. The margin (>1) keeps the canopy a productive
// SHELL rather than a deep stack of barely-breakeven leaves that would over-draw water — the
// exact over-packed-canopy failure auto-leaves is meant to prevent. Tuned against the harness.
export const LEAF_ENERGY_UPKEEP = 0.02
export const AUTO_LEAF_MIN_GEN = LEAF_ENERGY_UPKEEP * 1.3
// Leaves auto-grow only at least this many cells above the SPAWN ground (surfaceR(0), the
// stable reference — not the per-column surface, which is bumpy ±2-3 and would let a flat
// ground-hugging row count as "tall" over the dips). This is the load-bearing anti-exploit
// rule: without it, free auto-leaves let a ground-hugging sprawl carpet itself in unlimited
// full-sun (un-self-shaded) leaves with short water paths — the "ground crawler" — which
// out-scored a real tree ~5×. Requiring height enforces the core trade-off (grow a trunk to
// earn a canopy, then widen it to water that canopy). Low enough that a fresh seed (energy
// 8) can build a height-3 trunk turn one and start photosynthesizing — no bootstrap lock.
export const MIN_LEAF_HEIGHT = 3

// Auto-grow the canopy: the tree puts out leaves on every open above-ground hex adjacent to
// wood where a leaf's light income clears AUTO_LEAF_MIN_GEN, filling top-/sunniest-first and
// recomputing self-shading each pass so it never keeps a leaf another shades into deficit.
// This REPLACES manual leaf placement — the player shapes WOOD and the canopy follows the
// light. A ground-hugging or deeply-shaded hex never clears the bar (height-light factor +
// self-shading), so the canopy can't sprawl into parasites and the old crawler stays dead.
// New leaves are free and enter like any growth (water 2, energy 1, age 0). Pure.
function autoLeafFill(state: GameState, sunAngleDeg: number, intensity: number): { cells: Map<string, Cell>; added: Set<string> } {
  const work = new Map(state.cells)
  const added = new Set<string>()
  const groundR = surfaceR(0)  // stable spawn-ground reference for the height gate
  const mkLeaf = (q: number, r: number): Cell => ({ q, r, type: 'leaf', water: 2, energy: 1, health: 1, rot: 0, age: 0 })

  for (let pass = 0; pass < 40; pass++) {
    // Candidate hexes: empty air, adjacent to wood, above the local surface, AND at least
    // MIN_LEAF_HEIGHT above the spawn ground (so a low flat sprawl earns no canopy).
    const candidates = new Set<string>()
    for (const cell of work.values()) {
      if (cell.type !== 'tree') continue
      for (const [dq, dr] of HEX_NEIGHBORS) {
        const q = cell.q + dq, r = cell.r + dr
        if (r >= surfaceR(q)) continue              // not buried (above its local surface)
        if (groundR - r < MIN_LEAF_HEIGHT) continue // high enough above the spawn ground
        const k = hexKey(q, r)
        if (!work.has(k)) candidates.add(k)         // empty (air)
      }
    }
    if (candidates.size === 0) break

    // Tentatively place a leaf on every candidate, compute the resulting (self-shaded)
    // light, then keep only the ones still clearing the bar. Within a sun-column the
    // 0.65/cell falloff means only the top few survive, so this converges to a lit shell.
    const trial = new Map(work)
    for (const k of candidates) {
      const [q, r] = k.split(',').map(Number)
      trial.set(k, mkLeaf(q, r))
    }
    const light = computeLight({ ...state, cells: trial }, sunAngleDeg)

    let addedThisPass = false
    for (const k of candidates) {
      const [q, r] = k.split(',').map(Number)
      const gen = (light.get(k) ?? 0) * intensity * PHOTO_COEFF * heightLightFactor(q, r)
      if (gen > AUTO_LEAF_MIN_GEN) { work.set(k, mkLeaf(q, r)); added.add(k); addedThisPass = true }
    }
    if (!addedThisPass) break
  }
  return { cells: work, added }
}

// Grow the canopy for the season being simulated (called at growing-season tick 0).
export function growAutoLeaves(state: GameState, weather: SeasonWeather): GameState {
  return { ...state, cells: autoLeafFill(state, weather.sunAngleDeg, weather.intensity).cells }
}

// Keys auto-leaves would occupy for a given state + season light — for the planning preview.
export function autoLeafPreview(state: GameState, sunAngleDeg: number, intensity: number): Set<string> {
  return autoLeafFill(state, sunAngleDeg, intensity).added
}

// Carbon–water coupling: a dry leaf fixes less carbon (closed stomata admit less CO₂).
// Photosynthesis scales by the leaf's own water — full at `PHOTO_WATER_FULL`, ramping to
// `PHOTO_WATER_MIN` as water → 0. This is what makes the WATER SYSTEM (trunk width + roots,
// the conduction cap) the real cap on energy income: a canopy you can't water can't print
// energy, so you can't out-build your hydraulics. (Previously photosynthesis was purely
// light-driven and a bone-dry over-built canopy still banked unlimited energy — the runaway
// surplus that made energy meaningless.) It's safe to couple now that the canopy auto-grows
// fresh and free each spring: a small recovering tree's canopy sits near its roots and stays
// well-watered, so this throttles only genuinely over-extended canopies, not recovery.
export const PHOTO_WATER_FULL = 2.5
export const PHOTO_WATER_MIN = 0.15
export function photoWaterFactor(water: number): number {
  if (water >= PHOTO_WATER_FULL) return 1
  return PHOTO_WATER_MIN + (1 - PHOTO_WATER_MIN) * (water / PHOTO_WATER_FULL)
}

// Photosynthesis: leaf cells turn light into energy. Non-leaf cells receive energy
// only via diffusion — so canopy structure, not bulk, drives the energy economy.
export function photosynthesize(state: GameState, light: Map<string, number>, intensity: number): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'leaf') continue
    const ll = light.get(key)
    if (ll === undefined) continue
    const gain = ll * intensity * PHOTO_COEFF * heightLightFactor(cell.q, cell.r) * photoWaterFactor(cell.water)
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
      // Wood energy upkeep retuned 0.015 → 0.005. Now that wood HEALTH no longer depends on
      // energy (see updateHealth), this upkeep only taxes banked energy — and at 0.015 it
      // drained a small tree's whole summer surplus over fall (full-metabolism fall, canopy
      // still up) every year, trapping recovering/pruned trees in subsistence (they could
      // sustain but never re-bank a fall-surviving reserve). At 0.005 a modest canopy banks
      // a surplus that snowballs, so a brutally-pruned tree genuinely recovers (verified in
      // cli/recover.ts: spring budget climbs 8→14→29→49…). Structure is now cheap to keep.
      case 'tree':   w = 0.05; e = 0.005; break
      case 'leaf':   w = 0.10; e = LEAF_ENERGY_UPKEEP; break
      case 'flower': w = 0.15; e = 0.10; break
      case 'fruit':  w = 0.20; e = 0.05; break
    }
    if (w === 0 && e === 0) continue
    // Transpiring cells (leaf/fruit) throttle water loss when stressed — stomatal closure.
    if (cell.type === 'leaf' || cell.type === 'fruit') w *= stomataFactor(cell.water)
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

// Fraction of a pair's resource difference that moves per tick (before the flow cap).
// Conduction must be low-RESISTANCE so the per-cell 2-units/tick flow CAP — not gradient
// resistance — is the real throughput limit; that's what makes trunk WIDTH matter while
// still letting a tall trunk water its canopy. At 0.15 (the original value) gradient
// resistance dominated and any tree taller than ~6 rows starved its own canopy no matter
// how wide the trunk (verified in cli/experiments.ts). 0.5 saturates the cap quickly.
export const DIFFUSE_RATE = 0.5

// Generic single-pass diffusion across adjacent exchangeable pairs. Both water and
// energy diffusion share this: same flow rate, same shuffled-pair order, same per-cell
// in/out budget. The resource-specific bits are injected via `cfg`.
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
      Math.abs(diff) * DIFFUSE_RATE,
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

// Health update: each living cell's health lerps toward a target set by its supply.
// The lerp (not a fixed step) makes both decline and recovery gradual and slowing —
// trouble is visible long before death (CLAUDE.md "slow drama").
//
// Crucially the supply test is TYPE-AWARE:
//  • Wood (tree, trunk + roots) is mostly dead structural scaffolding with living sapwood
//    that just needs WATER moving through it — its health does NOT depend on energy. Energy
//    is the growth/reproduction currency (the planning budget), free to pool in the canopy
//    where photosynthesis makes it; a root at energy 0 sitting in wet soil is perfectly
//    healthy. (Before this, every wood cell needed energy>2, so energy made at the leaves
//    had to crawl all the way down to the roots — it never did, and every tree sat pinned
//    at health 0.5 with starved roots. That was both unrealistic and not fun.)
//  • Leaves / flowers / fruit are the metabolically active loads and need BOTH water and
//    energy — preserving the real challenges (watering a lifted canopy; feeding fruit out
//    on a far limb).
const DEATH_THRESHOLD = 0.001
export const WOOD_WATER_OK = 3      // wood at/above this water → full health
// Health floor for dry structural wood. Thirst alone NEVER kills wood — a dry cell goes
// dormant at half-health, not dead. Wood dies only from rot, storms, or pruning.
//
// Why (the deciduous bare-winter die-off): without a canopy there is no transpiration to
// pull water up, so the upper structure of any sizeable tree inevitably dried to ~0 over
// winter and the old `water ≤ 0.5 → target 0.0` rule then decayed it into deadwood every
// single year — a *size-punishing* death with no counterplay (the bigger/taller the tree,
// the more upper wood it shed each winter). It also manufactured the late-game "pile of
// dead crap to prune" chore. Real branches don't die over a normal dormant winter; dry
// sapwood just idles and re-hydrates when the canopy returns. Flooring at 0.5 keeps the
// real consequences — dry wood is visibly half-grey and can't anchor a flower (>0.6) — and
// the canopy challenge still bites where it should (LEAVES still need water AND energy and
// still die). Validated against the harness sweeps + a tall-tree winter survival check.
export const WOOD_DRY_HEALTH = 0.5
export function updateHealth(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type === 'deadwood' || cell.type === 'soil' || cell.type === 'rock') continue

    let target: number
    if (cell.type === 'tree') {
      // Water-driven, but thirst floors at WOOD_DRY_HEALTH — wood never dies of thirst.
      target = cell.water > WOOD_WATER_OK ? 1.0 : WOOD_DRY_HEALTH
    } else {
      const hasWater  = cell.water  > 3
      const hasEnergy = cell.energy > 2
      target = hasWater && hasEnergy ? 1.0 : hasWater || hasEnergy ? 0.5 : 0.0
    }

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

// Fruit maturation (Milestone 9): each tick a fruit's ripeness moves by its own water
// supply — fierce summer transpiration (0.20/tick) means a poorly-fed fruit can't keep
// up and visibly regresses. Well-fed it ripens toward FRUIT_RIPE; starved it slips to 0
// and aborts (drops, no seed). This is the central summer gamble: how many fruit can the
// roots actually carry through August. Runs after diffusion so water reflects the tick.
export function matureFruit(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'fruit') continue
    let m = cell.maturity ?? FRUIT_START_MATURITY
    if (cell.water >= FRUIT_FED_WATER) m = Math.min(FRUIT_RIPE, m + FRUIT_RIPEN_RATE)
    else if (cell.water < FRUIT_THIRSTY_WATER) m -= FRUIT_DECLINE_RATE
    if (m <= 0) work.delete(key)              // aborted — dropped, no seed
    else work.set(key, { ...cell, maturity: m })
  }
  return { ...state, cells: work }
}

// Stub: rot spread (deferred — see CLAUDE.md Decisions Deferred)
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

// Winter onset (first tick of winter): frost kills any ABOVE-GROUND growth placed during
// the winter planning phase (age 0). The canopy itself normally came down at fall's end
// (see resolveAutumnDrop), so entering winter the tree is already bare — but this stays a
// backstop: any leaf/flower/fruit still present at winter onset drops here too (a leaf
// resorbing the low frost fraction). Underground roots are INSULATED — new winter roots
// (age 0, below the surface) survive, which is the one constructive winter action.
function winterFrost(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type === 'leaf' || cell.type === 'flower' || cell.type === 'fruit') {
      if (cell.type === 'leaf') depositResorb(work, cell, cell.energy * LEAF_FROST_RESORB)
      work.delete(key)
    } else if (cell.type === 'tree' && cell.age === 0 && cell.r < surfaceR(cell.q)) {
      work.delete(key)  // above-ground winter growth frost-kills; roots are spared
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

// The deciduous drop, resolved at the END of FALL: the WHOLE canopy comes down and EVERY
// leaf resorbs LEAF_SHED_RESORB (75%) of its energy into the wood — automatically, no
// manual marking. (Originally the player had to tap each leaf to "shed" it for the good
// resorb rate, with un-shed leaves keeping only 30%; but since shedding everything was
// always strictly best, that was a pure busywork tax — playtesters reasonably asked why
// it wasn't automatic. It is now.) The leaves photosynthesized all fall first (this runs
// after the last tick), and the tree enters winter bare, on honest overwintering reserves.
function resolveAutumnDrop(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'leaf') continue
    depositResorb(work, cell, cell.energy * LEAF_SHED_RESORB)
    work.delete(key)
  }
  return { ...state, cells: work }
}

// Fruit set, resolved at the END of SPRING (after the last spring tick, like the autumn
// drop): every flower that kept its health above FLOWER_SET_HEALTH pollinates into a
// fruit; weaker flowers drop (a wasted 3-energy bloom — the spring lesson). New fruit
// start at FRUIT_START_MATURITY and carry that progress into the summer planning save.
export function setFruit(state: GameState): GameState {
  const work = new Map(state.cells)
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'flower') continue
    if (cell.health > FLOWER_SET_HEALTH) {
      work.set(key, { ...cell, type: 'fruit', maturity: FRUIT_START_MATURITY })
    } else {
      work.delete(key)
    }
  }
  return { ...state, cells: work }
}

// Harvest, resolved at the START of FALL (tick 0, like winter's frost): every fruit that
// reached ripeness yields one seed (score +1, flat); any fruit still short of ripe drops
// unharvested. Either way no fruit survives into fall — summer is the whole gauntlet.
// Returns the count harvested so the season summary can celebrate the haul.
export function ripenFruit(state: GameState): { state: GameState; harvested: number } {
  const work = new Map(state.cells)
  let harvested = 0
  let hadFruit = false
  for (const [key, cell] of state.cells) {
    if (cell.type !== 'fruit') continue
    hadFruit = true
    if ((cell.maturity ?? 0) >= FRUIT_RIPE) harvested++
    work.delete(key)  // every fruit leaves the tree at fall onset — ripe or not
  }
  if (!hadFruit) return { state, harvested: 0 }
  return { state: { ...state, cells: work, score: state.score + harvested }, harvested }
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
  // Fall onset harvest: ripe fruit becomes seeds, the rest drops (before the canopy
  // photosynthesizes fall — the fruit's work was done over summer).
  if (tick === 0 && weather.season === 'fall') s = ripenFruit(s).state
  // Growing-season onset: auto-grow the canopy on net-positive open hexes (replaces manual
  // leaf placement). Not in winter (frost would kill it). Spring starts bare → full re-leaf;
  // summer/fall top up any hexes opened by new wood. Fruit harvest above runs first.
  if (tick === 0 && weather.season !== 'winter') s = growAutoLeaves(s, weather)

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
  s = matureFruit(s)
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

export function runSeason(state: GameState, rng: RNG, weather: SeasonWeather): SeasonPlayback {
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
    // Fall: the whole canopy drops automatically (deciduous), every leaf resorbing the full
    // rate into the wood. Other seasons keep their canopy (it regrew at tick 0 and persists).
    let last = weather.season === 'fall' ? resolveAutumnDrop(frames[frames.length - 1]) : frames[frames.length - 1]
    // Spring: surviving flowers pollinate into fruit (the rest drop).
    if (weather.season === 'spring') last = setFruit(last)
    last = ageCells(last)
    frames[frames.length - 1] = last
  }
  return { frames, storms }
}

// Frames-only convenience wrapper — the shape the simulation tests assert against.
export function simulateSeason(state: GameState, rng: RNG, weather: SeasonWeather): GameState[] {
  return runSeason(state, rng, weather).frames
}

export { mulberry32 }
