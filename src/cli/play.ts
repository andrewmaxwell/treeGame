// Scripted playthroughs over the headless harness. Run: npx tsx src/cli/play.ts
import { Headless } from './headless'
import { surfaceR } from '../sim/terrain'
import { hexKey } from '../sim/grid'
import type { PlacementMode } from '../game/planning'

// ── growth helpers (operate via the real placement API) ───────────────────────
function cellsArr(g: Headless) { return [...g.game.cells.values()] }

function deepestRoot(g: Headless) {
  let best = null as null | { q: number; r: number }
  for (const c of cellsArr(g)) {
    if (c.type === 'tree' && c.r >= surfaceR(c.q)) {
      if (!best || c.r > best.r) best = { q: c.q, r: c.r }
    }
  }
  return best
}

// Topmost tree cell (smallest r) — the growing tip of the trunk. Falls back to the seed
// at the surface so the first above-ground cell can be grown.
function trunkTop(g: Headless) {
  let best = null as null | { q: number; r: number }
  for (const c of cellsArr(g)) {
    if (c.type === 'tree') {
      if (!best || c.r < best.r) best = { q: c.q, r: c.r }
    }
  }
  return best
}

// Extend the root system downward toward a target depth, dodging rock.
function extendDown(g: Headless, steps: number) {
  for (let i = 0; i < steps; i++) {
    const d = deepestRoot(g)
    if (!d) return
    const tries: [number, number][] = [[d.q, d.r + 1], [d.q + 1, d.r + 1], [d.q - 1, d.r + 1]]
    let done = false
    for (const [q, r] of tries) if (g.place(q, r, 'branch')) { done = true; break }
    if (!done) return
  }
}

// Extend trunk straight up.
function extendUp(g: Headless, steps: number) {
  for (let i = 0; i < steps; i++) {
    const t = trunkTop(g)
    if (!t) return
    if (!g.place(t.q, t.r - 1, 'branch')) {
      if (!g.place(t.q + 1, t.r - 1, 'branch') && !g.place(t.q - 1, t.r - 1, 'branch')) return
    }
  }
}

function widenTrunk(g: Headless, max: number) {
  // place wood next to existing above-ground trunk cells (branch mode), horizontally
  let n = 0
  const valid = g.validPlacements('branch')
  for (const [k, t] of valid) {
    if (n >= max) break
    if (t !== 'tree') continue
    const [q, r] = k.split(',').map(Number)
    if (r >= surfaceR(q)) continue // above ground only
    if (g.place(q, r, 'branch')) n++
  }
  return n
}

// ── a balanced grower strategy ─────────────────────────────────────────────────
function countType(g: Headless, pred: (c: { type: string; r: number; q: number; health: number }) => boolean) {
  let n = 0
  for (const c of cellsArr(g)) if (pred(c)) n++
  return n
}
function aboveTrunkHeight(g: Headless) {
  const t = trunkTop(g)
  return t ? surfaceR(t.q) - t.r : 0
}
function rootDepth(g: Headless) {
  const d = deepestRoot(g)
  return d ? d.r - surfaceR(d.q) : 0
}
function leafCount(g: Headless) { return countType(g, (c) => c.type === 'leaf') }

// Disciplined grower. The canopy auto-grows on the lit hexes now, so the strategy just
// shapes wood: roots for water, then a modest trunk + width. Keep a reserve in established
// seasons so growth's proportional energy cost doesn't crater health.
function balancedGrower(g: Headless) {
  const s = g.season
  if (s === 'winter') return
  if (s === 'fall') return  // canopy auto-sheds; nothing to do

  const cap = leafCount(g) === 0 || g.year <= 1 ? 1.0 : 0.6
  const under = () => g.spent < g.budget * cap

  // Structural targets are reached early, then frozen so upkeep stops creeping.
  if (g.year <= 3) {
    if (rootDepth(g) < 12 && under()) extendDown(g, 2)
    if (aboveTrunkHeight(g) < 7 && under()) extendUp(g, 1)
    if (aboveTrunkHeight(g) >= 3 && under()) widenTrunk(g, 1)
  }

  if (s === 'spring') g.fill('flower', 6, 0.6)
}

// Aggressive flowerer: establish fast, then pour every spring's surplus into blooms.
function flowerFocus(g: Headless) {
  const s = g.season
  if (s === 'winter') return
  if (s === 'fall') return
  if (g.year <= 2) {
    if (rootDepth(g) < 12) extendDown(g, 3)
    if (aboveTrunkHeight(g) < 6) extendUp(g, 1)
    widenTrunk(g, 2)
  }
  if (s === 'spring') g.fill('flower', 30, 0.8)
}

// Tall grower: the build the player WANTS to be able to make — a real tree. Wide trunk
// (width 3) for water throughput, tall (height ~11), deep roots, broad canopy, flowers
// every spring once established. Tests that "go tall" is viable, not punished.
function tallGrower(g: Headless) {
  const s = g.season
  if (s === 'winter') { if (rootDepth(g) < 16) extendDown(g, 2); return }
  if (s === 'fall') return

  const cap = leafCount(g) === 0 || g.year <= 1 ? 1.0 : 0.7
  const under = () => g.spent < g.budget * cap

  if (g.year <= 4) {
    if (rootDepth(g) < 16 && under()) extendDown(g, 2)
    if (aboveTrunkHeight(g) < 11 && under()) extendUp(g, 1)
    if (aboveTrunkHeight(g) >= 3 && under()) widenTrunk(g, 2)  // width for throughput
  }
  if (s === 'spring') g.fill('flower', 8, 0.7)
}

// Ground-crawler: the suspected exploit — sprawl wood horizontally just above the surface
// (every cell next to soil-water and unshaded sun), leaves on top, a few roots, flowers.
function groundCrawler(g: Headless) {
  const s = g.season
  if (s === 'winter') return
  if (s === 'fall') return
  const sr = surfaceR(0)
  const wood = cellsArr(g).filter((c) => c.type === 'tree' && c.r === sr - 1)
  let minQ = Infinity, maxQ = -Infinity
  for (const c of wood) { if (c.q < minQ) minQ = c.q; if (c.q > maxQ) maxQ = c.q }
  if (!isFinite(minQ)) g.place(0, sr - 1, 'branch')
  else for (let k = 0; k < 4; k++) { g.place(maxQ + 1 + k, sr - 1, 'branch'); g.place(minQ - 1 - k, sr - 1, 'branch') }
  if (g.year <= 2) extendDown(g, 2)
  if (s === 'spring') g.fill('flower', 40, 0.85)
}

// ── run + report ───────────────────────────────────────────────────────────────
function band(b: ReturnType<Headless['bands']>['top']) {
  if (!b) return '   —'
  return `n${b.n} w${b.water} e${b.energy} h${b.health}(min${b.minHealth})`
}

function run(label: string, worldSeed: number, years: number, strat: (g: Headless) => void) {
  console.log(`\n══════════ ${label} (worldSeed=${worldSeed}) ══════════`)
  const g = new Headless(worldSeed, worldSeed + 1)
  for (let i = 0; i < years * 4; i++) {
    const before = `${g.season[0].toUpperCase()}${g.year}`
    strat(g)
    const spentPct = g.budget > 0 ? Math.round((g.spent / g.budget) * 100) : 0
    const fd = g.flowerDiagnosis()
    const rep = g.advance()
    const bands = g.bands()
    const flowerNote = g.season === 'spring' || rep.season === 'spring'
      ? ` flowers:${fd.valid}(tips ${fd.healthyTips}/${fd.tips})` : ''
    console.log(
      `${before.padEnd(4)} ${rep.weather.padEnd(16)} ` +
      `bank ${rep.bankedBefore.toFixed(0)}→${rep.bankedAfter.toFixed(0).padEnd(3)} ` +
      `cells ${rep.cellsBefore}→${rep.cellsAfter} ` +
      `spent${spentPct}% seeds:${g.score} stressMax:${g.stressMax()}` +
      `${rep.cellsLostToStorm ? ` STORM-lost:${rep.cellsLostToStorm}` : ''}` +
      flowerNote,
    )
    console.log(`        bands top[${band(bands.top)}] mid[${band(bands.mid)}] low[${band(bands.low)}] roots[${band(bands.roots)}]`)
    const repro = rep.summaryEvents.filter((e) => /bloom|fruit|seed|Harvest/i.test(e))
    if (repro.length) console.log(`        ${repro.join('  ')}`)
    if (rep.newlyCompleted.length) console.log(`        🏅 ${rep.newlyCompleted.join(', ')}`)
    if (g.livingCount() === 0) { console.log('        💀 TREE DIED'); break }
  }
  console.log(`\nFINAL: year ${g.year}, score ${g.score}, cells ${g.livingCount()}, stressMax ${g.stressMax()}`)
  console.log(g.render())
}

// Quiet sweep: just the final outcome per seed, to see the distribution.
function sweep(label: string, strat: (g: Headless) => void, seeds: number[], years: number) {
  console.log(`\n──── sweep: ${label} (${years}y) ────`)
  const scores: number[] = []
  for (const seed of seeds) {
    const g = new Headless(seed, seed + 1)
    let died = 0
    for (let i = 0; i < years * 4; i++) { strat(g); g.advance(); if (g.livingCount() === 0) { died = g.year; break } }
    scores.push(g.score)
    console.log(`  seed ${String(seed).padStart(5)}: score ${String(g.score).padStart(3)} cells ${String(g.livingCount()).padStart(3)} ${died ? `DIED y${died}` : `alive y${g.year}`}`)
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  console.log(`  → avg score ${avg.toFixed(1)}, min ${Math.min(...scores)}, max ${Math.max(...scores)}`)
}

const SEEDS = [1234, 42, 7, 99, 2024, 555, 31337, 808]
const arg = process.argv[2]
if (arg === 'detail') {
  run('balanced grower A', 1234, 8, balancedGrower)
  run('flower focus A', 1234, 8, flowerFocus)
} else if (arg === 'tall') {
  run('tall grower A', 1234, 10, tallGrower)
} else {
  sweep('balancedGrower', balancedGrower, SEEDS, 10)
  sweep('tallGrower', tallGrower, SEEDS, 10)
  sweep('flowerFocus', flowerFocus, SEEDS, 10)
  sweep('groundCrawler', groundCrawler, SEEDS, 10)
}
