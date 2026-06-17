// Energy-economy check: an aggressive builder that pours its WHOLE budget into wood every
// season (the player who, drowning in surplus, just keeps building). Tracks banked energy,
// cell count, and average leaf water per year. With photosynthesis coupled to leaf water,
// an over-built canopy should dry out and throttle its own income — so banked energy should
// PLATEAU at a sane level (not run away to ~900 like the pre-coupling 273-cell tree).
// Run: npx tsx src/cli/bigtree.ts
import { Headless } from './headless'
import { surfaceR } from '../sim/terrain'

function cells(g: Headless) { return [...g.game.cells.values()] }
function deepestRoot(g: Headless) {
  let best: { q: number; r: number } | null = null
  for (const c of cells(g)) if (c.type === 'tree' && c.r >= surfaceR(c.q)) if (!best || c.r > best.r) best = { q: c.q, r: c.r }
  return best
}
function trunkTop(g: Headless) {
  let best: { q: number; r: number } | null = null
  for (const c of cells(g)) if (c.type === 'tree') if (!best || c.r < best.r) best = { q: c.q, r: c.r }
  return best
}
function spendOnWood(g: Headless) {
  // Greedily grow wood in every direction until the budget runs out.
  let guard = 0
  while (g.remaining >= 1 && guard++ < 400) {
    const d = deepestRoot(g), t = trunkTop(g)
    let did = false
    if (d) for (const [q, r] of [[d.q, d.r + 1], [d.q + 1, d.r + 1], [d.q - 1, d.r + 1]] as [number, number][]) if (g.place(q, r, 'branch')) { did = true; break }
    if (t && g.remaining >= 1) for (const [q, r] of [[t.q, t.r - 1], [t.q + 1, t.r - 1], [t.q - 1, t.r - 1]] as [number, number][]) if (g.place(q, r, 'branch')) { did = true; break }
    // widen
    if (g.remaining >= 1) for (const [k, ty] of g.validPlacements('branch')) {
      if (ty !== 'tree') continue
      const [q, r] = k.split(',').map(Number)
      if (r >= surfaceR(q)) continue
      if (g.place(q, r, 'branch')) { did = true; break }
    }
    if (!did) break
  }
}

const g = new Headless(2024)
console.log('year  season  cells  banked  leafWater(avg)  leaves')
for (let y = 1; y <= 8; y++) {
  for (let s = 0; s < 4; s++) {
    const season = g.season
    if (season !== 'winter' && season !== 'fall') spendOnWood(g)
    g.advance()
    if (g.season === 'fall') {
      const leaves = cells(g).filter((c) => c.type === 'leaf')
      const lw = leaves.length ? (leaves.reduce((a, c) => a + c.water, 0) / leaves.length).toFixed(2) : '—'
      console.log(`${String(g.year).padStart(3)}  ${season.padEnd(7)} ${String(g.livingCount()).padStart(5)}  ${String(Math.round(g.banked)).padStart(6)}  ${String(lw).padStart(8)}        ${leaves.length}`)
    }
  }
}
