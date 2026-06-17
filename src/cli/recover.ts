// Recovery harness: validates that a brutally-pruned (or never-leafed) tree can climb back
// out of subsistence rather than soft-locking. Run: npx tsx src/cli/recover.ts
// Prints the spring planning budget each year — it must SNOWBALL (e.g. 8 12 18 29 49…),
// not flat-line at the spring vigor floor. Guards the wood-upkeep / vigor-floor balance.
import { Headless } from './headless'
import { surfaceR } from '../sim/terrain'

const top = (g: Headless) => [...g.game.cells.values()].filter((c) => c.type === 'tree').sort((a, b) => a.r - b.r)[0]
const hgt = (g: Headless) => { const t = top(g); return t ? surfaceR(t.q) - t.r : 0 }

// From a single seed, the simplest possible play: keep a short trunk growing. The canopy
// auto-grows on the lit hexes now, so there's nothing to "fill" — if the economy is healthy
// this still snowballs.
const g = new Headless(1234, 5678)
const springBudgets: number[] = []
for (let i = 0; i < 40; i++) {
  const s = g.season
  if (s !== 'winter' && s !== 'fall') {
    if (hgt(g) < 5) { const t = top(g); if (t) g.place(t.q, t.r - 1, 'branch') }
  }
  if (s === 'spring') springBudgets.push(+g.budget.toFixed(0))
  g.advance()
}
console.log(`spring budgets by year: ${springBudgets.join(' ')} | final cells ${g.livingCount()} score ${g.score}`)
