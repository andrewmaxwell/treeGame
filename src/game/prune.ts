import type { Cell } from '../sim/cells'
import { HEX_NEIGHBORS, hexKey } from '../sim/grid'
import { surfaceR } from '../sim/terrain'

function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q)
}

const WOOD: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['tree', 'deadwood'])
const TERMINAL: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['leaf', 'flower', 'fruit'])

// The set of cell keys that would be removed if `targetKey` were pruned: the target
// itself, plus every living/deadwood cell that loses its connection to the root
// system as a result. Connectivity = BFS from underground tree cells through
// wood (tree + deadwood); terminals (leaf/flower/fruit) ride along on adjacent wood.
//
// Pure — does not mutate `cells`.
export function computeRemovalSet(cells: Map<string, Cell>, targetKey: string): Set<string> {
  const removed = new Set<string>()
  if (!cells.has(targetKey)) return removed
  removed.add(targetKey)

  // BFS roots: underground tree cells, excluding the pruned one.
  const reachable = new Set<string>()
  const queue: string[] = []
  for (const [key, cell] of cells) {
    if (key === targetKey) continue
    if (cell.type === 'tree' && isUnderground(cell)) {
      if (!reachable.has(key)) { reachable.add(key); queue.push(key) }
    }
  }

  // Spread through wood (tree/deadwood), never through the pruned cell.
  while (queue.length > 0) {
    const key = queue.shift()!
    const cell = cells.get(key)!
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(cell.q + dq, cell.r + dr)
      if (nk === targetKey || reachable.has(nk)) continue
      const n = cells.get(nk)
      if (n && WOOD.has(n.type)) { reachable.add(nk); queue.push(nk) }
    }
  }

  // Any wood not reached is cut off → removed.
  for (const [key, cell] of cells) {
    if (key === targetKey) continue
    if (WOOD.has(cell.type) && !reachable.has(key)) removed.add(key)
  }

  // A terminal survives only if adjacent to some surviving wood cell.
  for (const [key, cell] of cells) {
    if (!TERMINAL.has(cell.type) || removed.has(key)) continue
    let supported = false
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(cell.q + dq, cell.r + dr)
      const n = cells.get(nk)
      if (n && WOOD.has(n.type) && !removed.has(nk)) { supported = true; break }
    }
    if (!supported) removed.add(key)
  }

  return removed
}

// Pruning a healthy cell costs energy (wound sealing); pruning dead/dying/rotted
// wood is free counterplay.
export const PRUNE_COST = 2
export function pruneCost(cell: Cell): number {
  if (cell.type === 'deadwood') return 0
  if (cell.rot > 0) return 0
  if (cell.health < 0.3) return 0
  return PRUNE_COST
}

// True if pruning would sever the entire above-ground canopy from the roots — worth
// an extra confirmation. (Every above-ground living cell ends up in the removal set.)
export function seversWholeCanopy(cells: Map<string, Cell>, removed: Set<string>): boolean {
  let aboveGround = 0
  let aboveRemoved = 0
  for (const [key, cell] of cells) {
    if (cell.type === 'soil' || cell.type === 'rock') continue
    if (isUnderground(cell)) continue
    aboveGround++
    if (removed.has(key)) aboveRemoved++
  }
  return aboveGround > 0 && aboveRemoved === aboveGround
}
