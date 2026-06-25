import type { Cell } from "../sim/cells";
import { surfaceR } from "../sim/terrain";
import { applyBreakage } from "../sim/structure";

function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q);
}

// The set of cell keys that would be removed if `targetKey` were pruned: the target
// itself, plus every living/deadwood cell that loses its connection to the root
// system as a result. This is exactly a one-cell "breakage" — the same connectivity
// rule a storm snap uses (see sim/structure.applyBreakage), so prune and storm damage
// can never disagree about what falls.
//
// Pure — does not mutate `cells`.
export function computeRemovalSet(
  cells: Map<string, Cell>,
  targetKey: string,
): Set<string> {
  if (!cells.has(targetKey)) return new Set<string>();
  return applyBreakage(cells, new Set([targetKey]));
}

// Bulk prune (speed-pruning, playtest request): the full set removed when ALL of
// `selection` is cut at once — the selected cells plus everything that loses root
// connectivity. Computed in one breakage pass so the preview matches what a confirm
// does. Keys not present in `cells` are ignored. Pure.
export function computeMultiRemoval(
  cells: Map<string, Cell>,
  selection: Set<string>,
): Set<string> {
  const present = new Set<string>();
  for (const k of selection) if (cells.has(k)) present.add(k);
  if (present.size === 0) return new Set<string>();
  return applyBreakage(cells, present);
}

// Energy cost to bulk-prune: the wound-sealing cost of each EXPLICITLY selected cell
// (collaterally-disconnected cells aren't charged, matching the single-cell rule).
export function pruneSelectionCost(
  cells: Map<string, Cell>,
  selection: Set<string>,
): number {
  let cost = 0;
  for (const k of selection) {
    const c = cells.get(k);
    if (c) cost += pruneCost(c);
  }
  return cost;
}

// True if the removal would wipe out the ENTIRE living tree (every living cell, roots
// included) — which must be blocked: a tree can't prune itself out of existence (use
// "Plant a new seed" to start over). Guards the single-cell / whole-tree case.
export function removesEntireTree(
  cells: Map<string, Cell>,
  removed: Set<string>,
): boolean {
  let living = 0,
    livingRemoved = 0;
  for (const [key, cell] of cells) {
    if (
      cell.type === "soil" ||
      cell.type === "rock" ||
      cell.type === "deadwood"
    )
      continue;
    living++;
    if (removed.has(key)) livingRemoved++;
  }
  return living > 0 && livingRemoved === living;
}

// What the player may prune. Leaves are auto-grown and auto-dropped (M10), so the player
// never prunes them — removing a leaf is a pointless trap (it regrows free next spring and
// the canopy sheds itself every fall). Wood, deadwood, flowers, and fruit are pruneable;
// soil/rock and leaves are not. (Leaves still drop as free collateral when the wood they
// hang on is pruned — that's handled by applyBreakage, not by pruning the leaf directly.)
export function isPruneable(cell: Cell): boolean {
  return (
    cell.type === "tree" ||
    cell.type === "deadwood" ||
    cell.type === "flower" ||
    cell.type === "fruit"
  );
}

// Pruning a healthy wood cell costs energy (wound sealing); pruning dead/dying/rotted wood
// is free counterplay, and so is dropping a flower or fruit — soft tissue isn't a wound to
// seal, and dropping a doomed thirsty fruit to free up a limb's water is legitimate play.
export const PRUNE_COST = 2;
export function pruneCost(cell: Cell): number {
  if (cell.type === "flower" || cell.type === "fruit") return 0;
  if (cell.type === "deadwood") return 0;
  if (cell.rot > 0) return 0;
  if (cell.health < 0.3) return 0;
  return PRUNE_COST;
}

// True if pruning would sever the entire above-ground canopy from the roots — worth
// an extra confirmation. (Every above-ground living cell ends up in the removal set.)
export function seversWholeCanopy(
  cells: Map<string, Cell>,
  removed: Set<string>,
): boolean {
  let aboveGround = 0;
  let aboveRemoved = 0;
  for (const [key, cell] of cells) {
    if (cell.type === "soil" || cell.type === "rock") continue;
    if (isUnderground(cell)) continue;
    aboveGround++;
    if (removed.has(key)) aboveRemoved++;
  }
  return aboveGround > 0 && aboveRemoved === aboveGround;
}
