// Structural integrity (Milestone 8): the support graph, per-cell load/strength/
// stress, and the connectivity rule that decides what falls when wood is removed.
//
// Hex-grid trees can contain loops, so "the subtree above a cell" isn't well-defined
// by shape alone. We define support explicitly via a BFS from the root system and a
// per-cell support parent, then accumulate load down toward the ground. All pure —
// nothing here mutates the input map.

import type { Cell } from './cells'
import { HEX_NEIGHBORS, hexKey, hexPixelX } from './grid'
import { surfaceR } from './terrain'

const WOOD: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['tree', 'deadwood'])
const TERMINAL: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['leaf', 'flower', 'fruit'])

// A cell at or below its column's surface is part of the root system (it grounds the
// support graph). Above the surface it is load-bearing canopy/trunk.
function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q)
}

export interface StructureInfo {
  // Per wood-cell key. The renderer reddens stress > STRESS_WARN and storms snap cells
  // whose stress exceeds the storm's threshold. `moment` and `strength` are exposed for
  // the inspector / debugging.
  moment: Map<string, number>    // net horizontal bending moment from the load above
  strength: Map<string, number>
  stress: Map<string, number>
}

// Stress threshold above which a cell is visibly at risk (red tint, "storm risk").
export const STRESS_WARN = 0.8

// Stress = (|bending moment| · MOMENT_W + supported_count · LOAD_W) / strength.
//   • The moment term is the dominant one: it captures how *off-balance* the load a
//     cell carries is. A long one-sided branch piles up moment at its attachment; a
//     balanced canopy's left and right moments cancel, so it's barely stressed.
//   • The load term adds a little compression so a huge canopy on a thin trunk is not
//     completely storm-proof even when perfectly balanced.
// Calibrated (see scenarios in structure.test.ts) so: a compact/balanced canopy and a
// "visually straight up" zig-zag trunk stay well under STRESS_WARN; a ~5-long 1-wide
// horizontal cantilever reddens toward its base; and a deliberately one-sided/leaning
// structure climbs into storm-break range.
const MOMENT_W = 0.2
const LOAD_W = 0.03

export function computeStructure(cells: Map<string, Cell>): StructureInfo {
  // Wood-only view: trunk, branches, roots, and deadwood all bear load.
  const wood = new Map<string, Cell>()
  for (const [k, c] of cells) if (WOOD.has(c.type)) wood.set(k, c)

  // ── Multi-source BFS from the root system → distance-to-ground for each cell ──
  const dist = new Map<string, number>()
  const queue: string[] = []
  for (const [k, c] of wood) {
    if (isUnderground(c)) { dist.set(k, 0); queue.push(k) }
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head]
    const c = wood.get(k)!
    const d = dist.get(k)! + 1
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr)
      if (wood.has(nk) && !dist.has(nk)) { dist.set(nk, d); queue.push(nk) }
    }
  }

  // ── Support parent: the neighbour closest to ground (smallest BFS distance). ──
  // Ties prefer the neighbour more directly below (larger r, then smaller horizontal
  // offset) — branches hang from the wood beneath them, not off to the side.
  const parent = new Map<string, string | null>()
  for (const [k, c] of wood) {
    const d = dist.get(k)
    if (d === undefined || d === 0) { parent.set(k, null); continue }  // root or disconnected
    const cx = hexPixelX(c.q, c.r)
    let best: string | null = null
    let bestDist = Infinity, bestR = -Infinity, bestDx = Infinity
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr)
      const nc = wood.get(nk)
      const nd = nc ? dist.get(nk) : undefined
      if (nc === undefined || nd === undefined || nd >= d) continue  // must be closer to ground
      const ndx = Math.abs(hexPixelX(nc.q, nc.r) - cx)
      if (nd < bestDist ||
          (nd === bestDist && (nc.r > bestR || (nc.r === bestR && ndx < bestDx)))) {
        best = nk; bestDist = nd; bestR = nc.r; bestDx = ndx
      }
    }
    parent.set(k, best)
  }

  // ── Supported subtree: for each cell, the count and Σ pixel-x of every cell whose
  // support path runs through it (itself included). Accumulated from the canopy down,
  // so each cell knows exactly the load resting on it. Because each cell's figures
  // come only from the wood *above* it (relative to itself), thickening the trunk
  // lower down never changes an upper cell's stress — the surprising non-local jumps
  // of the old model are gone. ──
  const cnt = new Map<string, number>()
  const sumX = new Map<string, number>()
  for (const [k, c] of wood) { cnt.set(k, 1); sumX.set(k, hexPixelX(c.q, c.r)) }
  const order = [...wood.keys()]
    .filter((k) => dist.has(k))
    .sort((a, b) => dist.get(b)! - dist.get(a)!)  // farthest-from-ground first
  for (const k of order) {
    const p = parent.get(k)
    if (p != null) {
      cnt.set(p, cnt.get(p)! + cnt.get(k)!)
      sumX.set(p, sumX.get(p)! + sumX.get(k)!)
    }
  }

  // ── Strength: local cross-section — same-row wood within graph distance 2, ×3. ──
  // This is a *horizontal* cross-section (width), so it measures a vertical member's
  // girth: a 1-wide trunk is weak, a thick trunk strong. A long horizontal branch's own
  // cells look "wide" and read as strong — which is correct, because branches don't snap
  // mid-span; their bending moment is borne by the narrow trunk at the junction (where
  // its width is low and its stress therefore high). Min 3 (a lone cell), so stress
  // never divides by zero.
  const strength = new Map<string, number>()
  for (const [k, c] of wood) {
    let count = 0
    const seen = new Set<string>([k])
    let frontier = [k]
    for (let depth = 0; depth <= 2; depth++) {
      const next: string[] = []
      for (const fk of frontier) {
        const fc = wood.get(fk)!
        if (fc.r === c.r) count++
        if (depth === 2) continue
        for (const [dq, dr] of HEX_NEIGHBORS) {
          const nk = hexKey(fc.q + dq, fc.r + dr)
          if (wood.has(nk) && !seen.has(nk)) { seen.add(nk); next.push(nk) }
        }
      }
      frontier = next
    }
    strength.set(k, count * 3)
  }

  // ── Moment + stress. Moment = |Σ(x_above − x_self)| = the horizontal imbalance of
  // the supported load: zero for a balanced or purely-vertical load, large for a
  // one-sided cantilever (and largest at the limb's attachment, fading to zero at the
  // tip, where nothing hangs beyond it). ──
  const moment = new Map<string, number>()
  const stress = new Map<string, number>()
  for (const [k, c] of wood) {
    const cx = hexPixelX(c.q, c.r)
    const m = Math.abs(sumX.get(k)! - cnt.get(k)! * cx)
    moment.set(k, m)
    stress.set(k, (m * MOMENT_W + cnt.get(k)! * LOAD_W) / strength.get(k)!)
  }

  return { moment, strength, stress }
}

// Connectivity after wood is removed (a storm snap or a prune). Given the cells with
// `removed` cut out, returns the FULL set to delete: the removed cells, plus every
// wood cell no longer reachable from the root system, plus terminals (leaf/flower/
// fruit) left with no surviving wood neighbour. The fallen wood is gone — on the
// ground now, not part of the tree. Pure.
export function applyBreakage(cells: Map<string, Cell>, removed: Set<string>): Set<string> {
  const out = new Set(removed)

  // BFS from the surviving root system through surviving wood.
  const reachable = new Set<string>()
  const queue: string[] = []
  for (const [k, c] of cells) {
    if (out.has(k)) continue
    if (c.type === 'tree' && isUnderground(c)) { reachable.add(k); queue.push(k) }
  }
  for (let head = 0; head < queue.length; head++) {
    const c = cells.get(queue[head])!
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr)
      if (out.has(nk) || reachable.has(nk)) continue
      const n = cells.get(nk)
      if (n && WOOD.has(n.type)) { reachable.add(nk); queue.push(nk) }
    }
  }

  // Any wood the roots can no longer reach has fallen.
  for (const [k, c] of cells) {
    if (WOOD.has(c.type) && !reachable.has(k)) out.add(k)
  }

  // A terminal survives only while adjacent to some surviving wood cell.
  for (const [k, c] of cells) {
    if (!TERMINAL.has(c.type) || out.has(k)) continue
    let supported = false
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr)
      const n = cells.get(nk)
      if (n && WOOD.has(n.type) && !out.has(nk)) { supported = true; break }
    }
    if (!supported) out.add(k)
  }

  return out
}
