import type { Cell, CellType } from "../sim/cells";
import { HEX_NEIGHBORS, hexKey } from "../sim/grid";
import { surfaceR } from "../sim/terrain";
import type { GameState, Season } from "./state";

// Leaves are no longer placed by hand — they auto-grow on net-positive canopy hexes during
// the simulation (see growAutoLeaves in sim/simulate.ts). The player shapes WOOD and (in
// spring) FLOWERS; the canopy follows the light automatically.
export type PlacementMode = "branch" | "reinforced" | "flower";

export const CELL_COST = 1; // energy cost per staged tree/leaf cell
export const REINFORCED_COST = 2; // energy cost per staged reinforced-wood cell (½ stress, higher upkeep, no leaves/flowers)
export const FLOWER_COST = 3; // energy cost per staged flower (spring only)
// Health the anchoring wood needs to support a bloom (sickly wood can't flower).
export const FLOWER_ANCHOR_HEALTH = 0.6;

// Per-staged-cell energy cost (flowers and reinforced wood cost more) — used for spend tracking and refunds.
function stagedCost(cell: Cell): number {
  if (cell.type === "flower") return FLOWER_COST;
  if (cell.type === "reinforced wood") return REINFORCED_COST;
  return CELL_COST;
}

// Spring "vigor": a living tree always has at least this much budget in spring,
// representing reserves mobilized to flush new growth. It only matters when the tree
// has starved its banked energy toward zero — without it, a leafless tree at 0 energy
// can never afford the 1 energy a leaf costs, so it can never photosynthesize again
// (an unrecoverable softlock while still alive). The floor mints energy only into
// leaves you actually plant, so it's a recovery lifeline, not a free hoard.
export const SPRING_VIGOR = 3;

function isLivingType(t: CellType): boolean {
  return (
    t === "tree" ||
    t === "reinforced wood" ||
    t === "leaf" ||
    t === "flower" ||
    t === "fruit"
  );
}

// Total banked energy across all living cells — this is the planning budget.
export function bankedEnergy(cells: Map<string, Cell>): number {
  let sum = 0;
  for (const cell of cells.values()) {
    if (isLivingType(cell.type)) sum += cell.energy;
  }
  return sum;
}

// True if spending `cost` more energy stays within the budget. The >= comparison
// (not >) on the old check let a final placement overshoot a fractional budget.
function canAfford(planning: PlanningState, cost: number): boolean {
  return planning.energySpent + cost <= planning.energyAvailable;
}

export interface PlanningState {
  stagedCells: Map<string, Cell>;
  energyAvailable: number;
  // Tracks spending: +cost per staged cell, plus accrued prune wound-sealing costs.
  energySpent: number;
  // Energy spent sealing prune wounds this planning phase. Pruning itself removes
  // cells from the game state immediately; this is only the deducted cost, applied
  // to the surviving tree at season advance.
  pruneCostAccrued: number;
}

export function createPlanningState(energyAvailable: number): PlanningState {
  return {
    stagedCells: new Map(),
    energyAvailable,
    energySpent: 0,
    pruneCostAccrued: 0,
  };
}

export type TapKind =
  | "placed"
  | "unstaged"
  | "inspect"
  | "rejected_rock"
  | "rejected_energy"
  | "rejected_adjacent"
  | "rejected_winter" // above-ground growth in winter would frost-die (roots are ok)
  | "noop";

export interface TapResult {
  kind: TapKind;
  planning?: PlanningState;
}

export function handleTap(
  q: number,
  r: number,
  mode: PlacementMode,
  game: GameState,
  planning: PlanningState,
): TapResult {
  const key = hexKey(q, r);

  // 1. Tapped a staged cell → unstage (with cascade)
  if (planning.stagedCells.has(key)) {
    return {
      kind: "unstaged",
      planning: unstageWithCascade(key, planning, game),
    };
  }

  const realCell = game.cells.get(key);

  // Flower mode: spring-only blooms on healthy wood, cost 3. A flower may take an empty
  // hex OR replace a leaf (blooms grow where leaves would) so a leafy canopy still has
  // room to flower. Tapping any other occupied cell inspects it.
  if (mode === "flower") {
    if (
      realCell &&
      realCell.type !== "soil" &&
      realCell.type !== "rock" &&
      realCell.type !== "leaf"
    ) {
      return { kind: "inspect" };
    }
    if (game.terrain.get(q, r)?.type === "rock")
      return { kind: "rejected_rock" };
    if (!canAfford(planning, FLOWER_COST)) return { kind: "rejected_energy" };
    if (!canPlaceFlower(q, r, game, planning))
      return { kind: "rejected_adjacent" };
    const flower: Cell = {
      q,
      r,
      type: "flower",
      water: 2,
      energy: 1,
      health: 1,
      rot: 0,
      age: 0,
      staged: true,
    };
    const newStaged = new Map(planning.stagedCells);
    newStaged.set(key, flower);
    return {
      kind: "placed",
      planning: {
        ...planning,
        stagedCells: newStaged,
        energySpent: planning.energySpent + FLOWER_COST,
      },
    };
  }

  // 2. Tapped a real leaf → stage wood here, replacing the leaf on advance (a branch
  // growing up through the canopy). Leaves themselves aren't player-editable anymore.
  // Reinforced wood may also grow up through a leaf.
  if (realCell?.type === "leaf") {
    if (game.season === "winter") return { kind: "rejected_winter" }; // above-ground frost-dies
    const cost = mode === "reinforced" ? REINFORCED_COST : CELL_COST;
    if (!canAfford(planning, cost)) return { kind: "rejected_energy" };
    if (!isAdjacentToValidAnchor(q, r, game, planning))
      return { kind: "rejected_adjacent" };
    const replacement: Cell = {
      q,
      r,
      type: mode === "reinforced" ? "reinforced wood" : "tree",
      water: 2,
      energy: 1,
      health: 1,
      rot: 0,
      age: 0,
      staged: true,
    };
    const newStaged = new Map(planning.stagedCells);
    newStaged.set(key, replacement);
    return {
      kind: "placed",
      planning: {
        ...planning,
        stagedCells: newStaged,
        energySpent: planning.energySpent + cost,
      },
    };
  }

  // 3. Tapped a non-terrain real cell (tree/deadwood/flower/fruit; leaves handled
  // above) → open the inspector. Soil/rock are terrain — fall through to step 4.
  if (realCell && realCell.type !== "soil" && realCell.type !== "rock")
    return { kind: "inspect" };

  // 4. Empty (or terrain) cell — try to place

  // Rock check (terrain is authoritative for rock positions)
  const terrainCell = game.terrain.get(q, r);
  if (terrainCell?.type === "rock") return { kind: "rejected_rock" };

  // Adjacency check: must touch a real tree cell or staged tree cell (leaves are terminal)
  if (!isAdjacentToValidAnchor(q, r, game, planning))
    return { kind: "rejected_adjacent" };

  // Underground = at or below surface (a root); above = a branch. Both are wood.
  const underground = r >= surfaceR(q);

  // Winter dormancy: anything above ground frost-dies at winter onset, so don't let the
  // player waste energy on it. Underground roots are insulated and may still be grown.
  if (game.season === "winter" && !underground)
    return { kind: "rejected_winter" };

  // Energy check
  const placeCost = mode === "reinforced" ? REINFORCED_COST : CELL_COST;
  if (!canAfford(planning, placeCost)) return { kind: "rejected_energy" };

  // Every hand-placed cell is wood now (leaves auto-grow); underground = root, above = branch.
  // Reinforced wood has ½ structural stress but higher water upkeep and no leaves/flowers.
  const newCell: Cell = {
    q,
    r,
    type: mode === "reinforced" ? "reinforced wood" : "tree",
    water: 2,
    energy: 1,
    health: 1,
    rot: 0,
    age: 0,
    staged: true,
  };
  const newStaged = new Map(planning.stagedCells);
  newStaged.set(key, newCell);

  return {
    kind: "placed",
    planning: {
      ...planning,
      stagedCells: newStaged,
      energySpent: planning.energySpent + placeCost,
    },
  };
}

function isAdjacentToValidAnchor(
  q: number,
  r: number,
  game: GameState,
  planning: PlanningState,
): boolean {
  for (const [dq, dr] of HEX_NEIGHBORS) {
    const nkey = hexKey(q + dq, r + dr);
    const gameType = game.cells.get(nkey)?.type;
    if (gameType && ["tree", "reinforced wood"].includes(gameType)) return true;
    const stagedType = planning.stagedCells.get(nkey)?.type;
    if (stagedType && ["tree", "reinforced wood"].includes(stagedType))
      return true;
  }
  return false;
}

// ─── flower placement ───────────────────────────────────────────────────────────

// Healthy wood (a tree cell above ground with health > the anchor bar) at (q, r), real
// or staged this turn. Staged wood reads as fresh (health 1). Returns the cell or null.
function healthyWoodAt(
  q: number,
  r: number,
  game: GameState,
  planning: PlanningState,
): Cell | null {
  if (r >= surfaceR(q)) return null; // roots don't flower
  const real = game.cells.get(hexKey(q, r));
  if (real?.type === "tree")
    return real.health > FLOWER_ANCHOR_HEALTH ? real : null;
  const staged = planning.stagedCells.get(hexKey(q, r));
  if (staged?.type === "tree") return staged;
  return null;
}

// A flower may be staged at an empty above-ground hex (or one holding a leaf it replaces)
// adjacent to healthy wood, in spring. Dropping the old strict "branch tip" rule: a leafy
// canopy fills the tip hexes with leaves, so the tip rule left nowhere to bloom — blooms
// now grow among the leaves, gated by the supporting wood's health and the 3-energy cost.
export function canPlaceFlower(
  q: number,
  r: number,
  game: GameState,
  planning: PlanningState,
): boolean {
  if (game.season !== "spring") return false;
  if (r >= surfaceR(q)) return false; // above ground only
  if (planning.stagedCells.has(hexKey(q, r))) return false;
  const existing = game.cells.get(hexKey(q, r));
  if (existing && existing.type !== "leaf") return false; // empty, or a leaf to replace
  for (const [dq, dr] of HEX_NEIGHBORS) {
    if (healthyWoodAt(q + dq, r + dr, game, planning)) return true;
  }
  return false;
}

function unstageWithCascade(
  removedKey: string,
  planning: PlanningState,
  game: GameState,
): PlanningState {
  const removedCell = planning.stagedCells.get(removedKey);
  const newStaged = new Map(planning.stagedCells);
  newStaged.delete(removedKey);

  const reachable = computeReachable(newStaged, game);

  let refund = removedCell ? stagedCost(removedCell) : CELL_COST; // directly removed cell
  for (const [key, cell] of [...newStaged]) {
    if (!reachable.has(key)) {
      newStaged.delete(key);
      refund += stagedCost(cell);
    }
  }

  return {
    ...planning,
    stagedCells: newStaged,
    energySpent: planning.energySpent - refund,
  };
}

// Returns the set of staged cell keys reachable from real tree cells.
// Traversal goes through staged TREE cells only; staged leaf cells are
// reachable if they sit adjacent to any reachable tree cell.
export function computeReachable(
  staged: Map<string, Cell>,
  game: GameState,
): Set<string> {
  const reachable = new Set<string>();
  const queue: [number, number][] = [];

  // Seed: staged tree cells directly touching a real tree cell
  for (const [key, cell] of staged) {
    if (cell.type !== "tree" && cell.type !== "reinforced wood") continue;
    if (touchesRealTree(cell.q, cell.r, game)) {
      reachable.add(key);
      queue.push([cell.q, cell.r]);
    }
  }

  // BFS through staged tree cells
  while (queue.length > 0) {
    const [cq, cr] = queue.shift()!;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nkey = hexKey(cq + dq, cr + dr);
      if (!reachable.has(nkey)) {
        const nb = staged.get(nkey);
        if (nb?.type === "tree" || nb?.type === "reinforced wood") {
          reachable.add(nkey);
          queue.push([nb.q, nb.r]);
        }
      }
    }
  }

  // Staged terminal cells (leaf/flower) adjacent to any reachable tree or real tree
  for (const [key, cell] of staged) {
    if ((cell.type !== "leaf" && cell.type !== "flower") || reachable.has(key))
      continue;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nkey = hexKey(cell.q + dq, cell.r + dr);
      const isStagedTree =
        staged.get(nkey)?.type === "tree" && reachable.has(nkey);
      const isRealTree = game.cells.get(nkey)?.type === "tree";
      if (isStagedTree || isRealTree) {
        reachable.add(key);
        break;
      }
    }
  }

  return reachable;
}

export function getValidPlacements(
  mode: PlacementMode,
  game: GameState,
  planning: PlanningState,
): Map<string, "tree" | "flower"> {
  if (mode === "flower") return flowerPlacements(game, planning);
  const modeCost = mode === "reinforced" ? REINFORCED_COST : CELL_COST;
  if (!canAfford(planning, modeCost)) return new Map();

  const valid = new Map<string, "tree" | "flower">();

  const anchors: Array<[number, number]> = [];
  for (const [, cell] of game.cells) {
    if (cell.type === "tree") anchors.push([cell.q, cell.r]);
  }
  for (const [, cell] of planning.stagedCells) {
    if (cell.type === "tree") anchors.push([cell.q, cell.r]);
  }

  for (const [aq, ar] of anchors) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nq = aq + dq,
        nr = ar + dr;
      const nkey = hexKey(nq, nr);
      if (planning.stagedCells.has(nkey)) continue;

      const existing = game.cells.get(nkey);
      if (existing) {
        // Soil/rock cells in game.cells are terrain — can place on soil. A branch may
        // also grow up through a leaf (the leaf is replaced).
        const isTerrain = existing.type === "soil" || existing.type === "rock";
        if (!isTerrain && existing.type !== "leaf") continue;
      }

      const terrainCell = game.terrain.get(nq, nr);
      if (terrainCell?.type === "rock") continue;
      // Underground = at or below surface (soil exists there)
      const underground = nq !== undefined && nr >= surfaceR(nq);
      // Winter: only underground roots survive — don't offer above-ground spots.
      if (game.season === "winter" && !underground) continue;
      valid.set(nkey, "tree");
    }
  }

  return valid;
}

// Valid flower placements: empty/leaf above-ground hexes adjacent to healthy wood.
function flowerPlacements(
  game: GameState,
  planning: PlanningState,
): Map<string, "flower"> {
  const valid = new Map<string, "flower">();
  if (game.season !== "spring" || !canAfford(planning, FLOWER_COST))
    return valid;

  const anchors: Array<[number, number]> = [];
  for (const [, cell] of game.cells)
    if (cell.type === "tree" && cell.health > FLOWER_ANCHOR_HEALTH)
      anchors.push([cell.q, cell.r]);
  for (const [, cell] of planning.stagedCells)
    if (cell.type === "tree") anchors.push([cell.q, cell.r]);

  for (const [aq, ar] of anchors) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nkey = hexKey(aq + dq, ar + dr);
      if (valid.has(nkey)) continue;
      if (canPlaceFlower(aq + dq, ar + dr, game, planning))
        valid.set(nkey, "flower");
    }
  }
  return valid;
}

function touchesRealTree(q: number, r: number, game: GameState): boolean {
  for (const [dq, dr] of HEX_NEIGHBORS) {
    const t = game.cells.get(hexKey(q + dq, r + dr))?.type;
    if (t === "tree" || t === "reinforced wood") return true;
  }
  return false;
}

const SEASONS: Season[] = ["spring", "summer", "fall", "winter"];

// Commit the staged plan into the game state: deduct the plan's energy cost from the
// paying cells and promote staged cells to real ones. Does NOT touch the season label
// or half — that's the caller's job (a mid-season checkpoint commits without advancing
// the season; a season-end advance also rolls the label forward). Pure.
export function applyPlanCommit(
  game: GameState,
  planning: PlanningState,
): GameState {
  const newCells = new Map(game.cells);

  // Net energy cost of the plan: placements (flowers cost more) + prune wound-sealing.
  let stagedTotal = 0;
  for (const cell of planning.stagedCells.values())
    stagedTotal += stagedCost(cell);
  const netCost = stagedTotal + planning.pruneCostAccrued;

  // The payers: pre-existing living cells that survive the plan (not replaced by a
  // staged cell). New cells' starting energy is part of the cost.
  const payerKeys: string[] = [];
  let payerEnergy = 0;
  for (const [key, cell] of game.cells) {
    if (
      cell.type !== "tree" &&
      cell.type !== "leaf" &&
      cell.type !== "flower" &&
      cell.type !== "fruit"
    )
      continue;
    if (planning.stagedCells.has(key)) continue;
    payerKeys.push(key);
    payerEnergy += cell.energy;
  }

  if (netCost > 0 && payerEnergy > 0) {
    // Deduct proportionally: every cell gives up the same fraction of its stash.
    const scale = Math.max(0, 1 - netCost / payerEnergy);
    for (const key of payerKeys) {
      const c = newCells.get(key)!;
      newCells.set(key, { ...c, energy: c.energy * scale });
    }
  }

  // Promote staged cells to real cells (dropping the staged flag entirely)
  for (const [key, cell] of planning.stagedCells) {
    const { staged: _staged, ...real } = cell;
    newCells.set(key, real);
  }

  return { ...game, cells: newCells };
}

export function applySeasonAdvance(
  game: GameState,
  planning: PlanningState,
): GameState {
  const committed = applyPlanCommit(game, planning);

  // Advance season
  const nextIdx = (SEASONS.indexOf(game.season) + 1) % 4;
  const nextSeason = SEASONS[nextIdx];
  const nextYear = nextSeason === "spring" ? game.year + 1 : game.year;

  return { ...committed, season: nextSeason, seasonHalf: 0, year: nextYear };
}
