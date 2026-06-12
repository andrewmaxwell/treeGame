import type { Cell, CellType } from '../sim/cells'
import { HEX_NEIGHBORS, hexKey } from '../sim/grid'
import { surfaceR } from '../sim/terrain'
import type { GameState, Season } from './state'

export type PlacementMode = 'branch' | 'leaf'

export const CELL_COST = 1     // energy cost per staged tree/leaf cell

// Spring "vigor": a living tree always has at least this much budget in spring,
// representing reserves mobilized to flush new growth. It only matters when the tree
// has starved its banked energy toward zero — without it, a leafless tree at 0 energy
// can never afford the 1 energy a leaf costs, so it can never photosynthesize again
// (an unrecoverable softlock while still alive). The floor mints energy only into
// leaves you actually plant, so it's a recovery lifeline, not a free hoard.
export const SPRING_VIGOR = 3

function isLivingType(t: CellType): boolean {
  return t === 'tree' || t === 'leaf' || t === 'flower' || t === 'fruit'
}

// Total banked energy across all living cells — this is the planning budget.
export function bankedEnergy(cells: Map<string, Cell>): number {
  let sum = 0
  for (const cell of cells.values()) {
    if (isLivingType(cell.type)) sum += cell.energy
  }
  return sum
}

// True if spending `cost` more energy stays within the budget. The >= comparison
// (not >) on the old check let a final placement overshoot a fractional budget.
function canAfford(planning: PlanningState, cost: number): boolean {
  return planning.energySpent + cost <= planning.energyAvailable
}

export interface PlanningState {
  stagedCells: Map<string, Cell>
  shedMarked: Set<string>
  energyAvailable: number
  // Tracks spending: +1 per staged cell, minus the proportional refund per
  // shed-marked leaf (previews the season-advance refund so the live budget stays
  // accurate). Also includes accrued prune wound-sealing costs.
  energySpent: number
  // Energy spent sealing prune wounds this planning phase. Pruning itself removes
  // cells from the game state immediately; this is only the deducted cost, applied
  // to the surviving tree at season advance.
  pruneCostAccrued: number
}

export function createPlanningState(energyAvailable: number): PlanningState {
  return { stagedCells: new Map(), shedMarked: new Set(), energyAvailable, energySpent: 0, pruneCostAccrued: 0 }
}

export type TapKind =
  | 'placed'
  | 'unstaged'
  | 'shed_toggled'
  | 'inspect'
  | 'rejected_rock'
  | 'rejected_energy'
  | 'rejected_adjacent'
  | 'noop'

export interface TapResult {
  kind: TapKind
  planning?: PlanningState
}

export function handleTap(
  q: number, r: number,
  mode: PlacementMode,
  game: GameState,
  planning: PlanningState,
): TapResult {
  const key = hexKey(q, r)

  // 1. Tapped a staged cell → unstage (with cascade)
  if (planning.stagedCells.has(key)) {
    return { kind: 'unstaged', planning: unstageWithCascade(key, planning, game) }
  }

  const realCell = game.cells.get(key)

  // 2. Tapped a real leaf
  if (realCell?.type === 'leaf') {
    if (mode === 'leaf') {
      // leaf mode: toggle shed marker
      return { kind: 'shed_toggled', planning: toggleShed(key, planning) }
    }
    // branch mode: stage a tree cell here, replacing the leaf on advance. If the leaf
    // was shed-marked, clear the mark (it's being replaced, not shed). Shedding no
    // longer affects the budget, so the cost is just the branch.
    if (!canAfford(planning, CELL_COST)) return { kind: 'rejected_energy' }
    if (!isAdjacentToValidAnchor(q, r, game, planning)) return { kind: 'rejected_adjacent' }
    const replacement: Cell = { q, r, type: 'tree', water: 2, energy: 1, health: 1, rot: 0, age: 0, staged: true }
    const newStaged = new Map(planning.stagedCells)
    newStaged.set(key, replacement)
    let newShed = planning.shedMarked
    if (newShed.has(key)) {
      newShed = new Set(newShed)
      newShed.delete(key)
    }
    return {
      kind: 'placed',
      planning: { ...planning, stagedCells: newStaged, shedMarked: newShed, energySpent: planning.energySpent + CELL_COST },
    }
  }

  // 3. Tapped a non-terrain real cell (tree/deadwood/flower/fruit; leaves handled
  // above) → open the inspector. Soil/rock are terrain — fall through to step 4.
  if (realCell && realCell.type !== 'soil' && realCell.type !== 'rock') return { kind: 'inspect' }

  // 4. Empty (or terrain) cell — try to place

  // Rock check (terrain is authoritative for rock positions)
  const terrainCell = game.terrain.get(q, r)
  if (terrainCell?.type === 'rock') return { kind: 'rejected_rock' }

  // Adjacency check: must touch a real tree cell or staged tree cell (leaves are terminal)
  if (!isAdjacentToValidAnchor(q, r, game, planning)) return { kind: 'rejected_adjacent' }

  // Energy check
  if (!canAfford(planning, CELL_COST)) return { kind: 'rejected_energy' }

  // Underground (at or below surface) → always tree; above surface → type by mode
  const underground = r >= surfaceR(q)
  const cellType: CellType = mode === 'leaf' && !underground ? 'leaf' : 'tree'

  const newCell: Cell = { q, r, type: cellType, water: 2, energy: 1, health: 1, rot: 0, age: 0, staged: true }
  const newStaged = new Map(planning.stagedCells)
  newStaged.set(key, newCell)

  return { kind: 'placed', planning: { ...planning, stagedCells: newStaged, energySpent: planning.energySpent + CELL_COST } }
}

function isAdjacentToValidAnchor(q: number, r: number, game: GameState, planning: PlanningState): boolean {
  for (const [dq, dr] of HEX_NEIGHBORS) {
    const nkey = hexKey(q + dq, r + dr)
    if (game.cells.get(nkey)?.type === 'tree') return true
    if (planning.stagedCells.get(nkey)?.type === 'tree') return true
  }
  return false
}

// Shedding is budget-neutral during planning: the energy resorbs back into the tree
// at season end (in the simulation), so it shows up in next season's budget, not this
// one. Marking only flags the leaf to drop-with-resorption when the season runs.
function toggleShed(key: string, planning: PlanningState): PlanningState {
  const newShed = new Set(planning.shedMarked)
  if (newShed.has(key)) newShed.delete(key)
  else newShed.add(key)
  return { ...planning, shedMarked: newShed }
}

function unstageWithCascade(removedKey: string, planning: PlanningState, game: GameState): PlanningState {
  const newStaged = new Map(planning.stagedCells)
  newStaged.delete(removedKey)

  const reachable = computeReachable(newStaged, game)

  let refund = CELL_COST  // for the directly removed cell
  for (const key of [...newStaged.keys()]) {
    if (!reachable.has(key)) {
      newStaged.delete(key)
      refund += CELL_COST
    }
  }

  return { ...planning, stagedCells: newStaged, energySpent: planning.energySpent - refund }
}

// Returns the set of staged cell keys reachable from real tree cells.
// Traversal goes through staged TREE cells only; staged leaf cells are
// reachable if they sit adjacent to any reachable tree cell.
export function computeReachable(staged: Map<string, Cell>, game: GameState): Set<string> {
  const reachable = new Set<string>()
  const queue: [number, number][] = []

  // Seed: staged tree cells directly touching a real tree cell
  for (const [key, cell] of staged) {
    if (cell.type !== 'tree') continue
    if (touchesRealTree(cell.q, cell.r, game)) {
      reachable.add(key)
      queue.push([cell.q, cell.r])
    }
  }

  // BFS through staged tree cells
  while (queue.length > 0) {
    const [cq, cr] = queue.shift()!
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nkey = hexKey(cq + dq, cr + dr)
      if (!reachable.has(nkey)) {
        const nb = staged.get(nkey)
        if (nb?.type === 'tree') {
          reachable.add(nkey)
          queue.push([nb.q, nb.r])
        }
      }
    }
  }

  // Staged leaf cells adjacent to any reachable tree or real tree
  for (const [key, cell] of staged) {
    if (cell.type !== 'leaf' || reachable.has(key)) continue
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nkey = hexKey(cell.q + dq, cell.r + dr)
      const isStagedTree = staged.get(nkey)?.type === 'tree' && reachable.has(nkey)
      const isRealTree = game.cells.get(nkey)?.type === 'tree'
      if (isStagedTree || isRealTree) { reachable.add(key); break }
    }
  }

  return reachable
}

export function getValidPlacements(
  mode: PlacementMode,
  game: GameState,
  planning: PlanningState,
): Map<string, 'tree' | 'leaf'> {
  if (!canAfford(planning, CELL_COST)) return new Map()

  const valid = new Map<string, 'tree' | 'leaf'>()

  const anchors: Array<[number, number]> = []
  for (const [, cell] of game.cells) {
    if (cell.type === 'tree') anchors.push([cell.q, cell.r])
  }
  for (const [, cell] of planning.stagedCells) {
    if (cell.type === 'tree') anchors.push([cell.q, cell.r])
  }

  for (const [aq, ar] of anchors) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nq = aq + dq, nr = ar + dr
      const nkey = hexKey(nq, nr)
      if (planning.stagedCells.has(nkey)) continue

      const existing = game.cells.get(nkey)
      if (existing) {
        // Soil/rock cells in game.cells are terrain — can place on soil.
        // Leaves can be replaced by a branch in branch mode.
        const isTerrain = existing.type === 'soil' || existing.type === 'rock'
        const isReplaceableLeaf = existing.type === 'leaf' && mode === 'branch'
        if (!isTerrain && !isReplaceableLeaf) continue
      }

      const terrainCell = game.terrain.get(nq, nr)
      if (terrainCell?.type === 'rock') continue
      // Underground = at or below surface (soil exists there)
      const underground = nq !== undefined && nr >= surfaceR(nq)
      const type: 'tree' | 'leaf' = mode === 'leaf' && !underground ? 'leaf' : 'tree'
      valid.set(nkey, type)
    }
  }

  return valid
}

function touchesRealTree(q: number, r: number, game: GameState): boolean {
  for (const [dq, dr] of HEX_NEIGHBORS) {
    if (game.cells.get(hexKey(q + dq, r + dr))?.type === 'tree') return true
  }
  return false
}

const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter']

// The leaves a fall plan will actually shed: still real leaves, not overridden by a
// staged cell. Passed into the simulation, which resolves shedding at SEASON END
// (after the leaves have photosynthesized all season) — see resolveShedding in
// simulate.ts. Shedding early in the planning phase used to drop the leaves before
// the season ran, forfeiting that season's energy and starving the tree.
export function resolvableShedKeys(game: GameState, planning: PlanningState): Set<string> {
  const keys = new Set<string>()
  for (const key of planning.shedMarked) {
    if (!planning.stagedCells.has(key) && game.cells.get(key)?.type === 'leaf') keys.add(key)
  }
  return keys
}

export function applySeasonAdvance(game: GameState, planning: PlanningState): GameState {
  const newCells = new Map(game.cells)

  // Net energy cost of the plan: placements + prune wound-sealing. (Shedding no longer
  // refunds here — its resorption happens at season end, feeding next season's budget.)
  const netCost = planning.stagedCells.size * CELL_COST + planning.pruneCostAccrued

  // The payers: pre-existing living cells that survive the plan (not replaced by a
  // staged cell). New cells' starting energy is part of the cost. Shed-marked leaves
  // are still alive going into the simulation, so they pay their share too.
  const payerKeys: string[] = []
  let payerEnergy = 0
  for (const [key, cell] of game.cells) {
    if (cell.type !== 'tree' && cell.type !== 'leaf' && cell.type !== 'flower' && cell.type !== 'fruit') continue
    if (planning.stagedCells.has(key)) continue
    payerKeys.push(key)
    payerEnergy += cell.energy
  }

  if (netCost > 0 && payerEnergy > 0) {
    // Deduct proportionally: every cell gives up the same fraction of its stash.
    const scale = Math.max(0, 1 - netCost / payerEnergy)
    for (const key of payerKeys) {
      const c = newCells.get(key)!
      newCells.set(key, { ...c, energy: c.energy * scale })
    }
  }

  // Promote staged cells to real cells (dropping the staged flag entirely)
  for (const [key, cell] of planning.stagedCells) {
    const { staged: _staged, ...real } = cell
    newCells.set(key, real)
  }

  // Advance season
  const nextIdx = (SEASONS.indexOf(game.season) + 1) % 4
  const nextSeason = SEASONS[nextIdx]
  const nextYear = nextSeason === 'spring' ? game.year + 1 : game.year

  return { ...game, cells: newCells, season: nextSeason, year: nextYear }
}
