// Structural integrity (Milestone 8): the support graph, per-cell load/strength/
// stress, and the connectivity rule that decides what falls when wood is removed.
//
// Hex-grid trees can contain loops, so "the subtree above a cell" isn't well-defined
// by shape alone. We define support explicitly via a BFS from the root system, then
// integrate the internal bending moment down toward the ground, sharing load across all
// parallel paths (see "The load-sharing bending model" below). All pure — nothing here
// mutates the input map.

import type { Cell } from "./cells";
import { HEX_NEIGHBORS, hexKey, hexPixelX } from "./grid";
import { surfaceR } from "./terrain";

const WOOD: ReadonlySet<Cell["type"]> = new Set<Cell["type"]>([
  "tree",
  "deadwood",
  "reinforced wood",
]);
const TERMINAL: ReadonlySet<Cell["type"]> = new Set<Cell["type"]>([
  "leaf",
  "flower",
  "fruit",
]);

// A cell at or below its column's surface is part of the root system (it grounds the
// support graph). Above the surface it is load-bearing canopy/trunk.
function isUnderground(cell: Cell): boolean {
  return cell.r >= surfaceR(cell.q);
}

export interface StructureInfo {
  // Per wood-cell key. The renderer reddens stress > STRESS_WARN and storms snap cells
  // whose stress exceeds the storm's threshold. `moment` (combined gravity + wind
  // bending demand) and `strength` are exposed for the inspector / debugging.
  moment: Map<string, number>;
  strength: Map<string, number>;
  stress: Map<string, number>;
}

// Stress threshold above which a cell is visibly at risk (red tint, "storm risk").
export const STRESS_WARN = 0.8;

// ── The load-sharing bending model ──────────────────────────────────────────────
//
// We treat the tree as a discrete truss of cells and compute, for each cell, the
// internal *bending moment* it must resist divided by its local cross-section
// (`strength`). Two independent load cases are summed:
//
//   • GRAVITY (always): every cell's weight pulls straight down. The moment on a cell
//     is the *horizontal* lever-arm of the weight it carries — Σ weight·(x_above −
//     x_self). Left and right loads cancel, so a balanced canopy is nearly moment-free
//     while a one-sided cantilever piles moment up toward its attachment (and ~0 at the
//     tip, where nothing hangs beyond it). This is the horizontal-branch case.
//
//   • WIND (a fixed reference breeze, always): every above-ground cell catches a
//     horizontal wind force. Its moment is the *vertical* lever-arm — Σ force·(height_
//     above − height_self). Wind pushes one way so these do NOT cancel: a tall trunk
//     accumulates a large overturning moment at its base regardless of how balanced it
//     is. This is the tall-skinny-tree case. (Direction-free in 2D: the magnitude
//     depends only on heights, so we needn't pick a wind direction.) Leaves catch wind
//     too (a leafy crown is a sail), so a tall canopy raises its trunk's base stress.
//
// THE KEY FIX (vs the old single-support-parent model): load is shared across *all*
// parallel paths to ground. Each cell pushes its accumulated load down, split equally
// among every neighbour closer to the ground. So when a branch lands on the middle of a
// thick trunk, its load fans out across the whole trunk within a row or two instead of
// funnelling down one column and lighting up a single cell — the reported "random hot
// cell in a thick trunk" bug. Combined with dividing by cross-section width, a doubled
// trunk sheds stress more than linearly (≈ beam theory's M/width²): a thick tree goes
// evenly, gently stressed; a 1-wide trunk has nowhere to spread.
//
// stress = (gravityMoment·MOMENT_W + windMoment·WIND_W + load·LOAD_W) / strength.
// The small LOAD_W compression term keeps a huge balanced canopy on a thin trunk from
// being completely storm-proof. Constants calibrated (see structure.test.ts and
// cli/structure.ts) against the existing storm thresholds (minor 1.2 / moderate 0.9 /
// severe 0.6) and STRESS_WARN so a normal balanced tree stays clear of the red line
// while long cantilevers and tall skinny trunks climb into storm-break range.
const MOMENT_W = 0.2;
const WIND_W = 0.03;
const LOAD_W = 0.03;

// Per-cell weight (gravity load). Wood is the unit; a fruit is heavy (~2.5 wood cells),
// a flower light, a leaf weightless. Reproductive load makes a fruit-laden cantilever
// redden and snap — losing the whole limb's harvest (Milestone 9).
const GRAVITY_WEIGHT: Partial<Record<Cell["type"], number>> = {
  tree: 1,
  "reinforced wood": 1,
  deadwood: 1,
  flower: 0.5,
  fruit: 2.5,
  leaf: 0,
};

// Per-cell wind catchment (horizontal force the reference breeze exerts). Bare wood
// catches some; a leaf/flower is a broad sail for its size; a fruit is a bluff body.
// Only applied above ground (roots catch no wind). A leafy crown's many leaves are the
// dominant sail on a tall tree — the reason height invites wind.
const WIND_AREA: Partial<Record<Cell["type"], number>> = {
  tree: 0.5,
  "reinforced wood": 0.5,
  deadwood: 0.5,
  leaf: 0.35,
  flower: 0.4,
  fruit: 0.6,
};

// Pack a hex coordinate into a single integer for the coord→index lookup below. Supports
// |q|,|r| < COORD_OFF (a 10k-cell tree spans tens of cells); a perfect hash, so the
// lookup is exact. Lets computeStructure resolve neighbours without allocating "q,r"
// strings (hexKey) in any of its O(cells·6) passes — the dominant cost on a big tree.
const COORD_OFF = 1 << 13; // 8192
const COORD_SPAN = 1 << 14; // 16384
function packCoord(q: number, r: number): number {
  return (q + COORD_OFF) * COORD_SPAN + (r + COORD_OFF);
}

// A cross-section shares its load as a rigid unit. Within each connected group of
// same-distance wood cells (a horizontal cross-section of a trunk, or the thickness of a
// branch), average each accumulated quantity so no single cell hoards its neighbours'
// load. This is what stops an edge cell — one with only a single downward parent — from
// becoming a funnel that lights up while its identical row-mates stay cold (the reported
// "random hot cell in a thick trunk" bug). A 1-wide member is one cell per layer, so it
// is left untouched (a cantilever and a skinny trunk behave exactly as the raw beam
// integration). Operates on wood indices via the prebuilt adjacency list; mutates the
// per-cell arrays in place.
function equalizeLayer(
  layer: number[],
  adj: number[][],
  arrays: Float64Array[],
): void {
  const inLayer = new Set(layer);
  const seen = new Set<number>();
  for (const start of layer) {
    if (seen.has(start)) continue;
    const comp: number[] = [start];
    seen.add(start);
    for (let head = 0; head < comp.length; head++) {
      for (const j of adj[comp[head]]) {
        if (inLayer.has(j) && !seen.has(j)) {
          seen.add(j);
          comp.push(j);
        }
      }
    }
    if (comp.length < 2) continue;
    for (const arr of arrays) {
      let sum = 0;
      for (const k of comp) sum += arr[k];
      const avg = sum / comp.length;
      for (const k of comp) arr[k] = avg;
    }
  }
}

export function computeStructure(cells: Map<string, Cell>): StructureInfo {
  // ── Index every wood cell, then do all graph work on integer indices + typed arrays.
  // No hexKey (string) allocation and no per-cell Set allocation in any pass — both were
  // the dominant per-tap cost on a large tree (the planning-phase lag). Geometry that the
  // inner loops reuse (cross-section width, pixel-x, wind height, underground flag) is
  // precomputed once per cell. ──
  const K: string[] = []; // original map key per wood index (for the output maps)
  const Wr: number[] = []; // r per wood index
  const Wtype: Cell["type"][] = [];
  const px: number[] = []; // hexPixelX per wood index (gravity lever-arm)
  const ht: number[] = []; // height above own surface per wood index (wind lever-arm)
  const under: boolean[] = [];
  const coordIdx = new Map<number, number>();
  for (const [k, c] of cells) {
    if (!WOOD.has(c.type)) continue;
    const i = K.length;
    K.push(k);
    Wr.push(c.r);
    Wtype.push(c.type);
    px.push(hexPixelX(c.q, c.r));
    const sr = surfaceR(c.q);
    ht.push(Math.max(0, sr - c.r));
    under.push(c.r >= sr);
    coordIdx.set(packCoord(c.q, c.r), i);
  }
  const n = K.length;

  // Wood-neighbour adjacency, built once (the only place neighbour coords are resolved).
  const adj: number[][] = new Array(n);
  for (const [, c] of cells) {
    if (!WOOD.has(c.type)) continue;
    const i = coordIdx.get(packCoord(c.q, c.r))!;
    const a: number[] = [];
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const j = coordIdx.get(packCoord(c.q + dq, c.r + dr));
      if (j !== undefined) a.push(j);
    }
    adj[i] = a;
  }

  // ── Multi-source BFS from the root system → distance-to-ground (−1 = unreachable). ──
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++)
    if (under[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const d = dist[i] + 1;
    for (const j of adj[i])
      if (dist[j] === -1) {
        dist[j] = d;
        queue.push(j);
      }
  }

  // ── Per-cell internal forces, integrated like a discrete beam (dM = V·ds). Each cell
  // carries a SHEAR (the load passing through it) and a BENDING MOMENT, kept separately
  // for the two load cases:
  //   • gravity: Vg = supported weight (vertical shear); Mg = bending moment. A load
  //     stepping DOWN by Δx horizontally adds Vg·Δx to the moment — so a vertical run
  //     adds nothing (no bending) and only a horizontal reach (a cantilever) builds Mg.
  //   • wind: Vw = supported wind force (horizontal shear); Mw = bending moment. A step
  //     DOWN by Δh in height adds Vw·Δh — so height builds the overturning moment.
  // Moments are signed during accumulation so symmetric loads cancel (a balanced canopy,
  // or the ±x zig-zag of a straight vertical trunk); |M| is taken only at the end. ──
  const Vg = new Float64Array(n);
  const Mg = new Float64Array(n);
  const Vw = new Float64Array(n);
  const Mw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    Vg[i] = GRAVITY_WEIGHT[Wtype[i]] ?? 1;
    Vw[i] = under[i] ? 0 : (WIND_AREA[Wtype[i]] ?? 0);
  }

  // Hang each leaf/flower/fruit's weight and wind onto one anchoring wood cell — the
  // adjacent wood closest to ground (tie: more directly below) — so the load reads as
  // resting on the limb beneath it. A terminal offset to the side of its anchor seeds a
  // little moment there (a fruit cantilevered off a twig). (Leaves weigh nothing but
  // still catch wind — a sail.)
  for (const [, c] of cells) {
    if (!TERMINAL.has(c.type)) continue;
    let best = -1;
    let bestDist = Infinity,
      bestR = -Infinity;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const j = coordIdx.get(packCoord(c.q + dq, c.r + dr));
      if (j === undefined) continue;
      const nd = dist[j];
      if (nd < 0) continue;
      if (nd < bestDist || (nd === bestDist && Wr[j] > bestR)) {
        best = j;
        bestDist = nd;
        bestR = Wr[j];
      }
    }
    if (best === -1) continue;
    const w = GRAVITY_WEIGHT[c.type] ?? 0;
    Vg[best] += w;
    Mg[best] += w * (hexPixelX(c.q, c.r) - px[best]);
    const f = WIND_AREA[c.type] ?? 0;
    Vw[best] += f;
    Mw[best] += f * (Math.max(0, surfaceR(c.q) - c.r) - ht[best]);
  }

  // ── Down-accumulation, processed one distance-layer at a time from the canopy down.
  // For each layer: (1) the cross-section laterally equalizes its accumulated load
  // (equalizeLayer — a wide trunk shares, an edge cell can't hoard), then (2) every cell
  // pushes its load down, split equally among each neighbour strictly closer to ground.
  // Splitting across parallel paths spreads a branch's load across a thick trunk; each
  // parent inherits its share of the child's moment PLUS the new moment from the load's
  // shear over the child→parent step — gravity over the horizontal step (Δx), wind over
  // the vertical step (Δh). Roots (distance 0) are anchors — load stops there. ──
  const byDist: number[][] = [];
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d < 0) continue;
    (byDist[d] ??= []).push(i);
    if (d > maxDist) maxDist = d;
  }
  for (let d = maxDist; d >= 1; d--) {
    const layer = byDist[d];
    if (!layer) continue;
    equalizeLayer(layer, adj, [Vg, Mg, Vw, Mw]);
    for (const i of layer) {
      const cx = px[i];
      const ch = ht[i];
      let parentCount = 0;
      for (const j of adj[i]) if (dist[j] >= 0 && dist[j] < d) parentCount++;
      if (parentCount === 0) continue; // disconnected fragment
      const share = 1 / parentCount;
      const vg = Vg[i] * share,
        mg = Mg[i] * share,
        vw = Vw[i] * share,
        mw = Mw[i] * share;
      for (const j of adj[i]) {
        if (!(dist[j] >= 0 && dist[j] < d)) continue;
        Vg[j] += vg;
        Mg[j] += mg + vg * (cx - px[j]);
        Vw[j] += vw;
        Mw[j] += mw + vw * (ch - ht[j]);
      }
    }
  }

  // ── Strength: local cross-section — same-row wood within graph distance 2, ×3. ──
  // This is a *horizontal* cross-section (width), so it measures a vertical member's
  // girth: a 1-wide trunk is weak, a thick trunk strong. A long horizontal branch's own
  // cells look "wide" and read as strong — which is correct, because branches don't snap
  // mid-span; their bending moment is borne by the narrow trunk at the junction (where
  // its width is low and its stress therefore high). Min 3 (a lone cell), so stress
  // never divides by zero. A generation-stamped visited array avoids a per-cell Set.
  const strength = new Float64Array(n);
  const stamp = new Int32Array(n);
  let gen = 0;
  let frontier: number[] = [];
  let next: number[] = [];
  for (let i = 0; i < n; i++) {
    gen++;
    let count = 0;
    const ri = Wr[i];
    stamp[i] = gen;
    frontier.length = 0;
    frontier.push(i);
    for (let depth = 0; depth <= 2; depth++) {
      next.length = 0;
      for (const fi of frontier) {
        if (Wr[fi] === ri) count++;
        if (depth === 2) continue;
        for (const j of adj[fi])
          if (stamp[j] !== gen) {
            stamp[j] = gen;
            next.push(j);
          }
      }
      const tmp = frontier;
      frontier = next;
      next = tmp;
    }
    strength[i] = count * 3;
  }

  // ── Moment + stress. Each cell's gravity and wind bending demand (magnitudes of the
  // integrated moments), plus a small axial-compression term from the weight it carries
  // so a huge balanced canopy on a thin trunk is not completely storm-proof, all divided
  // by its cross-section. ──
  const moment = new Map<string, number>();
  const strengthMap = new Map<string, number>();
  const stress = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const gravM = Math.abs(Mg[i]);
    const windM = Math.abs(Mw[i]);
    const bend = gravM * MOMENT_W + windM * WIND_W;
    const stressAmt = (bend + Vg[i] * LOAD_W) / strength[i];
    const momentAmt = gravM + windM;
    const reinforced = Wtype[i] === "reinforced wood";
    const key = K[i];
    moment.set(key, reinforced ? momentAmt / 2 : momentAmt);
    strengthMap.set(key, strength[i]);
    stress.set(key, reinforced ? stressAmt / 2 : stressAmt);
  }

  return { moment, strength: strengthMap, stress };
}

// Connectivity after wood is removed (a storm snap or a prune). Given the cells with
// `removed` cut out, returns the FULL set to delete: the removed cells, plus every
// wood cell no longer reachable from the root system, plus terminals (leaf/flower/
// fruit) left with no surviving wood neighbour. The fallen wood is gone — on the
// ground now, not part of the tree. Pure.
export function applyBreakage(
  cells: Map<string, Cell>,
  removed: Set<string>,
): Set<string> {
  const out = new Set(removed);

  // BFS from the surviving root system through surviving wood.
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const [k, c] of cells) {
    if (out.has(k)) continue;
    if (
      (c.type === "tree" || c.type === "reinforced wood") &&
      isUnderground(c)
    ) {
      reachable.add(k);
      queue.push(k);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const c = cells.get(queue[head])!;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr);
      if (out.has(nk) || reachable.has(nk)) continue;
      const n = cells.get(nk);
      if (n && WOOD.has(n.type)) {
        reachable.add(nk);
        queue.push(nk);
      }
    }
  }

  // Any wood the roots can no longer reach has fallen.
  for (const [k, c] of cells) {
    if (WOOD.has(c.type) && !reachable.has(k)) out.add(k);
  }

  // A terminal survives only while adjacent to some surviving wood cell.
  for (const [k, c] of cells) {
    if (!TERMINAL.has(c.type) || out.has(k)) continue;
    let supported = false;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr);
      const n = cells.get(nk);
      if (n && WOOD.has(n.type) && !out.has(nk)) {
        supported = true;
        break;
      }
    }
    if (!supported) out.add(k);
  }

  return out;
}
