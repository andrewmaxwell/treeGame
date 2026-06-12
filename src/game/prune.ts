import type { Cell } from '../sim/cells'
import { surfaceR } from '../sim/terrain'
import { applyBreakage } from '../sim/structure'

function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q)
}

// The set of cell keys that would be removed if `targetKey` were pruned: the target
// itself, plus every living/deadwood cell that loses its connection to the root
// system as a result. This is exactly a one-cell "breakage" — the same connectivity
// rule a storm snap uses (see sim/structure.applyBreakage), so prune and storm damage
// can never disagree about what falls.
//
// Pure — does not mutate `cells`.
export function computeRemovalSet(cells: Map<string, Cell>, targetKey: string): Set<string> {
  if (!cells.has(targetKey)) return new Set<string>()
  return applyBreakage(cells, new Set([targetKey]))
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
