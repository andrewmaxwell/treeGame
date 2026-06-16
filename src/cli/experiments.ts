// Controlled micro-experiments to quantify the water/energy conduction limits, so any
// rebalance is evidence-based. Run: npx tsx src/cli/experiments.ts
import { createInitialState, type GameState } from '../game/state'
import { runSeason, mulberry32 } from '../sim/simulate'
import { generateWeather } from '../sim/weather'
import { surfaceR } from '../sim/terrain'
import { hexKey } from '../sim/grid'
import type { Cell } from '../sim/cells'

function tree(q: number, r: number, opts: Partial<Cell> = {}): Cell {
  return { q, r, type: 'tree', water: 5, energy: 5, health: 1, rot: 0, age: 0, ...opts }
}

// A 1-or-wide vertical trunk of `height` above-ground rows, a small root pad in wet soil,
// and `leaves` leaf cells at the top. Width = cells per trunk row (centered).
function buildTrunk(height: number, width: number, leaves: number): GameState {
  const g = createInitialState()
  const cells = new Map<string, Cell>()
  const S = surfaceR(0)
  const offs = (w: number) => {
    const out: number[] = []
    for (let i = 0; i < w; i++) out.push(i % 2 === 0 ? i / 2 : -(i + 1) / 2)
    return out
  }
  const cols = offs(width)
  // roots: 4 rows below surface, full width, plus wet soil around them
  for (let d = 0; d <= 4; d++) for (const c of cols) cells.set(hexKey(c, S + d), tree(c, S + d, { water: 8 }))
  for (let d = -1; d <= 5; d++) for (let c = -3; c <= 3; c++) {
    const k = hexKey(c, S + d)
    if (!cells.has(k) && S + d >= surfaceR(c)) cells.set(k, { q: c, r: S + d, type: 'soil', water: 20, energy: 0, health: 1, rot: 0, age: 0 })
  }
  // trunk up
  for (let h = 1; h <= height; h++) for (const c of cols) cells.set(hexKey(c, S - h), tree(c, S - h, { water: 5 }))
  // canopy: leaves hugging the top few trunk rows so EVERY leaf is adjacent to wood
  // (a realistic canopy, not a single wide row whose outer leaves touch only air).
  let placed = 0
  for (let h = height; h >= 1 && placed < leaves; h--) {
    const r = S - h
    for (const c of cols) {
      for (const dq of [c - 1, c + 1]) {
        if (placed >= leaves) break
        const k = hexKey(dq, r)
        if (!cells.has(k)) { cells.set(k, { q: dq, r, type: 'leaf', water: 5, energy: 5, health: 1, rot: 0, age: 0 }); placed++ }
      }
    }
  }
  return { ...g, cells, season: 'summer' }
}

// Per-band health/water/energy of the final state — the real question is whether a tall
// tree can keep its WHOLE column healthy, not just the leaf water number.
function bandHealth(state: GameState) {
  const S = surfaceR(0)
  const grp = (pred: (c: Cell) => boolean) => {
    const cs = [...state.cells.values()].filter(pred)
    if (!cs.length) return '  —'
    const avg = (f: (c: Cell) => number) => cs.reduce((a, c) => a + f(c), 0) / cs.length
    return `h${avg((c) => c.health).toFixed(2)} w${avg((c) => c.water).toFixed(1)} e${avg((c) => c.energy).toFixed(1)}`
  }
  return {
    leaf: grp((c) => c.type === 'leaf'),
    canopyWood: grp((c) => c.type === 'tree' && c.r < S - 4),
    midTrunk: grp((c) => c.type === 'tree' && c.r >= S - 4 && c.r < S),
    roots: grp((c) => c.type === 'tree' && c.r >= S),
  }
}

function topStats(state: GameState) {
  let leafW = 0, leafE = 0, ln = 0, topTrunkW = 0
  let minR = Infinity
  for (const c of state.cells.values()) if (c.type === 'leaf') { leafW += c.water; leafE += c.energy; ln++ }
  for (const c of state.cells.values()) if (c.type === 'tree' && c.r < minR && c.r < surfaceR(c.q)) minR = c.r
  for (const c of state.cells.values()) if (c.type === 'tree' && c.r === minR) topTrunkW = c.water
  return { leafW: ln ? leafW / ln : 0, leafE: ln ? leafE / ln : 0, topTrunkW }
}

function runSummer(state: GameState) {
  const w = generateWeather('summer', 3, state.worldSeed)
  const frames = runSeason(state, mulberry32(state.rngSeed), w).frames
  return frames[frames.length - 1]
}

console.log('Conduction experiment — per-band health/water/energy at end of a summer season')
console.log('Can a TALL tree keep leaf + trunk + roots all healthy? Need leaf water>3 for h1.\n')
console.log('height width leaves | leaves               canopyWood          midTrunk            roots')
for (const [h, wid, lv] of [
  [4, 1, 6], [4, 3, 6],
  [8, 1, 10], [8, 3, 12], [8, 5, 14],
  [12, 3, 14], [12, 5, 16], [12, 7, 18],
  [16, 5, 18], [16, 7, 20],
] as [number, number, number][]) {
  const final = runSummer(buildTrunk(h, wid, lv))
  const b = bandHealth(final)
  console.log(
    `${String(h).padStart(6)} ${String(wid).padStart(5)} ${String(lv).padStart(6)} | ` +
    `${b.leaf.padEnd(19)} ${b.canopyWood.padEnd(19)} ${b.midTrunk.padEnd(19)} ${b.roots}`,
  )
}
