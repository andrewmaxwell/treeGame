// Tree diagnostic report — a dense, plain-text snapshot of a run's health, built from
// a GameState. Pure (no DOM, no fs, no console) so it works both in the browser console
// (App logs it on load) and the headless CLI (src/cli/diagnose.ts).
//
// It answers, with hard numbers instead of eyeballing the canvas: how many leaves are
// net-negative "parasites", canopy water demand vs trunk supply, wood-health and the
// flower-anchor lockout, energy headroom, root depth, and structural stress.

import { computeLight, PHOTO_COEFF, LIGHT_GROUND_FACTOR, LIGHT_FULL_HEIGHT } from '../sim/simulate'
import { computeStructure, STRESS_WARN } from '../sim/structure'
import { SEASON_PARAMS } from '../sim/weather'
import { surfaceR } from '../sim/terrain'
import { HEX_NEIGHBORS, hexKey } from '../sim/grid'
import { CELL_ENERGY_CAP } from '../sim/cells'
import type { Cell } from '../sim/cells'
import type { GameState } from './state'

// Metabolism (mirrors metabolize() in simulate.ts; duplicated here so this stays read-only).
const LEAF_WATER = 0.10, LEAF_ENERGY = 0.02
const WOOD_WATER = 0.05
const FLOWER_ANCHOR_HEALTH = 0.6
const WOOD_WATER_OK = 3  // wood is fully healthy above this water

function heightLightFactor(q: number, r: number): number {
  const h = surfaceR(q) - r
  if (h <= 0) return LIGHT_GROUND_FACTOR
  return Math.min(1, LIGHT_GROUND_FACTOR + (h / LIGHT_FULL_HEIGHT) * (1 - LIGHT_GROUND_FACTOR))
}

function isUnderground(c: Cell): boolean { return c.r >= surfaceR(c.q) }

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`
}

function stats(xs: number[]): { min: number; avg: number; max: number } {
  if (xs.length === 0) return { min: 0, avg: 0, max: 0 }
  let min = Infinity, max = -Infinity, sum = 0
  for (const x of xs) { if (x < min) min = x; if (x > max) max = x; sum += x }
  return { min, avg: sum / xs.length, max }
}

export function diagnoseReport(game: GameState): string {
  const out: string[] = []
  const line = (label: string, value: string) => out.push(`  ${label.padEnd(34)} ${value}`)

  const cells = game.cells
  const params = SEASON_PARAMS[game.season]
  const intensity = params.intensity

  // ── Census ────────────────────────────────────────────────────────────────
  const leaves: Cell[] = [], woodAbove: Cell[] = [], roots: Cell[] = []
  let flowers = 0, fruit = 0, deadwood = 0
  for (const c of cells.values()) {
    switch (c.type) {
      case 'leaf': leaves.push(c); break
      case 'tree': (isUnderground(c) ? roots : woodAbove).push(c); break
      case 'flower': flowers++; break
      case 'fruit': fruit++; break
      case 'deadwood': deadwood++; break
    }
  }
  const living = leaves.length + woodAbove.length + roots.length + flowers + fruit

  out.push(`\n══ Tree diagnosis — ${game.season} Y${game.year} · score ${game.score} ══\n`)
  line('Living cells', `${living}  (leaves ${leaves.length}, trunk/branch ${woodAbove.length}, roots ${roots.length}, flowers ${flowers}, fruit ${fruit})`)
  line('Deadwood', `${deadwood}`)

  // ── Light & the parasite question ───────────────────────────────────────────
  // A leaf nets energy only if  light·intensity·PHOTO_COEFF·heightFactor > its 0.02
  // upkeep. Below that it is a net energy LOSS and STILL transpires 0.10 water/tick —
  // a parasite. (computeLight is the real per-column self-shading model.)
  const light = computeLight(game, params.sunAngleDeg)
  let parasites = 0, freeloaders = 0
  const leafLightLevels: number[] = []
  for (const c of leaves) {
    const ll = light.get(hexKey(c.q, c.r)) ?? 0
    leafLightLevels.push(ll)
    const gen = ll * intensity * PHOTO_COEFF * heightLightFactor(c.q, c.r)
    if (gen <= LEAF_ENERGY) parasites++
    else if (gen < LEAF_ENERGY * 1.2) freeloaders++
  }
  const ls = stats(leafLightLevels)
  out.push(`\n── Canopy light (${game.season}, intensity ${intensity}) ──`)
  line('Leaf light level (remaining)', `min ${ls.min.toFixed(2)}  avg ${ls.avg.toFixed(2)}  max ${ls.max.toFixed(2)}`)
  line('Net-NEGATIVE leaves (parasites)', `${parasites} / ${leaves.length}  (${pct(parasites, leaves.length)}) — cost water+energy, make none`)
  line('Barely-breakeven leaves', `${freeloaders} / ${leaves.length}  (${pct(freeloaders, leaves.length)})`)
  out.push('  (a parasite still transpires 0.10 water/tick — pruning it RAISES net energy and frees water)')

  // ── Water supply vs demand ──────────────────────────────────────────────────
  // Demand = transpiration + wood upkeep. Supply proxy = trunk bases × 2 units/tick
  // (each surface-crossing wood cell can conduct at most 2/tick up from the roots).
  const demand = leaves.length * LEAF_WATER + (woodAbove.length + flowers + fruit) * WOOD_WATER
  let trunkBases = 0
  for (const c of woodAbove) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const n = cells.get(hexKey(c.q + dq, c.r + dr))
      if (n && n.type === 'tree' && isUnderground(n)) { trunkBases++; break }
    }
  }
  const supply = trunkBases * 2
  const woodWater = stats(woodAbove.map((c) => c.water))
  const leafWater = stats(leaves.map((c) => c.water))
  out.push(`\n── Water ──`)
  line('Canopy demand (units/tick)', `${demand.toFixed(1)}  (${leaves.length} leaves×0.10 + ${woodAbove.length + flowers + fruit} wood/repro×0.05)`)
  line('Trunk supply ceiling', `${supply.toFixed(1)}  (${trunkBases} surface trunks × 2/tick)`)
  line('Supply ÷ demand', `${demand === 0 ? '—' : (supply / demand).toFixed(2)}×  ${supply < demand ? '⚠️  UNDER-WATERED' : 'ok'}`)
  line('Above-ground wood water', `min ${woodWater.min.toFixed(1)}  avg ${woodWater.avg.toFixed(1)}  max ${woodWater.max.toFixed(1)}  (healthy needs > ${WOOD_WATER_OK})`)
  line('Leaf water', `min ${leafWater.min.toFixed(1)}  avg ${leafWater.avg.toFixed(1)}  max ${leafWater.max.toFixed(1)}`)

  // ── Health & the flower lockout ─────────────────────────────────────────────
  const woodSick = woodAbove.filter((c) => c.health < FLOWER_ANCHOR_HEALTH).length
  const woodDry = woodAbove.filter((c) => c.health < 0.55).length  // at/near the dry-dormant floor
  const leafSick = leaves.filter((c) => c.health < 0.5).length
  let flowerAnchors = 0
  for (const c of woodAbove) {
    if (c.health <= FLOWER_ANCHOR_HEALTH) continue
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nq = c.q + dq, nr = c.r + dr
      if (nr >= surfaceR(nq)) continue
      const n = cells.get(hexKey(nq, nr))
      if (!n || n.type === 'leaf') { flowerAnchors++; break }
    }
  }
  out.push(`\n── Health & flowering ──`)
  line('Wood below flower-anchor (0.6)', `${woodSick} / ${woodAbove.length}  (${pct(woodSick, woodAbove.length)}) — too dry to bloom on`)
  line('Wood dry/dormant (~0.5 floor)', `${woodDry}  (dry wood idles at half-health; it re-greens when watered, never dies of thirst)`)
  line('Leaves graying (<0.5 health)', `${leafSick} / ${leaves.length}  (${pct(leafSick, leaves.length)})`)
  line('Healthy flower anchors', `${flowerAnchors}  ${flowerAnchors === 0 ? '← can plant 0 flowers right now' : ''}`)

  // ── Energy ──────────────────────────────────────────────────────────────────
  let banked = 0
  for (const c of cells.values()) {
    if (c.type === 'tree' || c.type === 'leaf' || c.type === 'flower' || c.type === 'fruit') banked += c.energy
  }
  const cap = living * CELL_ENERGY_CAP
  out.push(`\n── Energy ──`)
  line('Banked (planning budget)', `${banked.toFixed(0)}`)
  line('Storage ceiling (living×10)', `${cap}  → ${pct(banked, cap)} full ${banked > 0.9 * cap ? '⚠️  near cap, income is being WASTED' : ''}`)

  // ── Roots ─────────────────────────────────────────────────────────────────
  let maxDepth = 0, waterTableRoots = 0
  for (const c of roots) {
    const depth = c.r - surfaceR(c.q)
    if (depth > maxDepth) maxDepth = depth
    if (depth >= 18) waterTableRoots++
  }
  out.push(`\n── Roots ──`)
  line('Max depth / water-table roots', `${maxDepth} deep · ${waterTableRoots} at the table (≥18)`)

  // ── Structure ───────────────────────────────────────────────────────────────
  const { stress } = computeStructure(cells)
  let maxStress = 0, atRisk = 0
  for (const s of stress.values()) { if (s > maxStress) maxStress = s; if (s > STRESS_WARN) atRisk++ }
  out.push(`\n── Structure ──`)
  line('Max stress / cells at risk', `${maxStress.toFixed(2)} · ${atRisk} over ${STRESS_WARN}`)

  // ── Verdict ─────────────────────────────────────────────────────────────────
  out.push(`\n── Verdict ──`)
  const notes: string[] = []
  if (demand > 0 && supply < demand) notes.push(`Under-watered: canopy wants ${demand.toFixed(0)}/tick, trunks cap at ${supply.toFixed(0)}/tick. Thin the canopy or widen trunks.`)
  if (leaves.length > 0 && parasites > leaves.length * 0.25) notes.push(`${pct(parasites, leaves.length)} of leaves are net-negative (shaded). They drain water for no gain — prune them.`)
  if (flowerAnchors === 0 && game.season === 'spring') notes.push(`No healthy flower anchors — wood health < 0.6 everywhere a bloom could go. Fix water first.`)
  if (banked > 0.9 * cap) notes.push(`Energy is capped (${pct(banked, cap)}) — you're wasting income. Spend on flowers (spring) or growth.`)
  if (notes.length === 0) notes.push('No dominant problem flagged — tree looks balanced.')
  notes.forEach((n, i) => out.push(`  ${i + 1}. ${n}`))
  out.push('')

  return out.join('\n')
}
