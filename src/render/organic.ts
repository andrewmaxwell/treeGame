import { hexKey, HEX_NEIGHBORS } from "../sim/grid";
import type { Cell } from "../sim/cells";
import { surfaceR } from "../sim/terrain";
import { cellColor, lerpColor } from "./colors";

// The tree drawn as a tree. The sim and every planning tool still work on hexes; this pass
// only changes how living cells look: wood becomes limbs joining neighbouring cell centres,
// tapered by how much wood each one carries, leaves become overlapping foliage clumps, and
// flowers and fruit hang off their twigs. Render-only, like the rest of render/.

export interface PlacedCell {
  cell: Cell;
  key: string;
  sx: number; // screen centre (already swayed)
  sy: number;
  s: number; // grow-in scale, 1 when settled
}

const WOOD: ReadonlySet<Cell["type"]> = new Set<Cell["type"]>([
  "tree",
  "reinforced wood",
  "deadwood",
]);
export const isWood = (c: Cell) => WOOD.has(c.type);

// Wood thickness from the pipe model (da Vinci's rule): a limb's cross-section carries
// everything beyond it, so its radius grows with the square root of the wood it supports.
// "Beyond" is along a breadth-first tree grown from the soil-line row, upward into the
// branches and downward into the roots. Leaves aren't counted so a trunk keeps its girth
// when the canopy drops in fall.
interface Topology {
  size: Map<string, number>; // wood cells supported, including itself
  twig: Map<string, string>; // non-wood living cell → the wood cell it hangs from
}

const topoCache = new WeakMap<Map<string, Cell>, Topology>();

export function treeTopology(cells: Map<string, Cell>): Topology {
  const hit = topoCache.get(cells);
  if (hit) return hit;
  const order: string[] = [];
  const parent = new Map<string, string | null>();
  for (const [k, c] of cells)
    if (isWood(c) && c.r === surfaceR(c.q)) {
      parent.set(k, null);
      order.push(k);
    }
  for (let i = 0; i < order.length; i++) {
    const c = cells.get(order[i])!;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr);
      if (parent.has(nk)) continue;
      const n = cells.get(nk);
      if (!n || !isWood(n)) continue;
      // Stay on one side of the soil line so roots and branches are separate systems.
      if (c.r !== surfaceR(c.q) && below(n) !== below(c)) continue;
      parent.set(nk, order[i]);
      order.push(nk);
    }
  }
  const size = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const k = order[i];
    const s = (size.get(k) ?? 0) + 1;
    size.set(k, s);
    const p = parent.get(k);
    if (p) size.set(p, (size.get(p) ?? 0) + s);
  }
  const twig = new Map<string, string>();
  for (const [k, c] of cells) {
    if (isWood(c) || !LIVING_EXTRA.has(c.type)) continue;
    let best: string | null = null;
    let bestSize = -1;
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const nk = hexKey(c.q + dq, c.r + dr);
      const n = cells.get(nk);
      if (!n || !isWood(n)) continue;
      const s = size.get(nk) ?? 1;
      // Hang from the thinnest wood neighbour: leaves grow on twigs, not on the trunk.
      if (best === null || s < bestSize) {
        best = nk;
        bestSize = s;
      }
    }
    if (best) twig.set(k, best);
  }
  const topo = { size, twig };
  topoCache.set(cells, topo);
  return topo;
}

const below = (c: Cell) => c.r > surfaceR(c.q);

const LIVING_EXTRA: ReadonlySet<Cell["type"]> = new Set<Cell["type"]>([
  "leaf",
  "flower",
  "fruit",
]);

export function woodRadius(
  supported: number,
  r: number,
  root: boolean,
): number {
  const f = Math.min(0.92, 0.34 + 0.09 * Math.sqrt(supported));
  return r * f * (root ? 0.85 : 1);
}

// Cheap stable per-cell randomness for clump jitter, so the canopy doesn't crawl between frames.
function hash(q: number, r: number, i: number): number {
  let h = (q * 374761393 + r * 668265263 + i * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface OrganicOpts {
  r: number; // on-screen hex radius
  light: Map<string, number>; // 0–1 sun per leaf (computeLight); shaded leaves draw darker
  autumn: number; // 0–1 how far the canopy has turned
  shimmerNow: number | null; // ms during playback, null otherwise
}

export function drawOrganicTree(
  ctx: CanvasRenderingContext2D,
  placed: PlacedCell[],
  cells: Map<string, Cell>,
  opts: OrganicOpts,
): void {
  const { r } = opts;
  const topo = treeTopology(cells);
  const at = new Map<string, PlacedCell>();
  for (const p of placed) at.set(p.key, p);
  const rad = (p: PlacedCell) =>
    woodRadius(topo.size.get(p.key) ?? 1, r, below(p.cell)) * p.s;

  // ── Wood: one path per colour for the bark, one shared outline and highlight ──
  const outline = new Path2D();
  const bark = new Map<string, Path2D>();
  const barkPath = (color: string) => {
    let p = bark.get(color);
    if (!p) bark.set(color, (p = new Path2D()));
    return p;
  };
  const edge = 1.2 + r * 0.06;
  for (const p of placed) {
    if (!isWood(p.cell)) continue;
    const ra = rad(p);
    const color = barkColor(p.cell);
    disc(outline, p.sx, p.sy, ra + edge);
    disc(barkPath(color), p.sx, p.sy, ra);
    // Each neighbouring pair once: right, lower-right, upper-right.
    for (const d of [0, 2, 4]) {
      const [dq, dr] = HEX_NEIGHBORS[d];
      const n = at.get(hexKey(p.cell.q + dq, p.cell.r + dr));
      if (!n || !isWood(n.cell)) continue;
      const rb = rad(n);
      limb(outline, p.sx, p.sy, ra + edge, n.sx, n.sy, rb + edge);
      limb(barkPath(color), p.sx, p.sy, ra, n.sx, n.sy, rb);
    }
  }
  // A soft shadow on the side away from the sun (upper left), then the outline and bark.
  ctx.save();
  ctx.translate(r * 0.12, r * 0.06);
  ctx.fillStyle = "rgba(20,10,0,0.25)";
  ctx.fill(outline);
  ctx.restore();
  ctx.fillStyle = "rgba(28,16,6,0.55)";
  ctx.fill(outline);
  // Lit bark first, then the bark again nudged away from the sun and clipped to the wood,
  // leaving a band of light along every limb's upper-left edge.
  const allBark = new Path2D();
  for (const [color, p] of bark) {
    allBark.addPath(p);
    ctx.fillStyle = lerpColor(color, "#e8c28a", 0.35);
    ctx.fill(p);
  }
  ctx.save();
  ctx.clip(allBark);
  ctx.translate(r * 0.14, r * 0.08);
  for (const [color, p] of bark) {
    ctx.fillStyle = color;
    ctx.fill(p);
  }
  ctx.restore();

  // Leaves sit a quarter of the way in toward the wood they hang from, so a lone leaf
  // hugs its branch instead of floating a hex away from it.
  for (const p of placed) {
    if (p.cell.type !== "leaf") continue;
    const w = topo.twig.get(p.key);
    const from = w && at.get(w);
    if (!from) continue;
    p.sx += (from.sx - p.sx) * 0.25;
    p.sy += (from.sy - p.sy) * 0.25;
  }

  // ── Twigs out to leaves, flowers and fruit ──────────────────────────────────
  ctx.strokeStyle = "rgba(70,45,22,0.9)";
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const p of placed) {
    const w = topo.twig.get(p.key);
    const from = w && at.get(w);
    if (!from) continue;
    ctx.moveTo(from.sx, from.sy);
    ctx.lineTo(p.sx, p.sy);
  }
  ctx.stroke();

  // ── Canopy: three overlapping discs per leaf, merged into one silhouette ────
  const leaves = placed.filter((p) => p.cell.type === "leaf");
  const shade = new Path2D();
  const light = new Path2D();
  const greens = new Map<string, Path2D>();
  for (const p of leaves) {
    const { q, r: rr } = p.cell;
    const lr = r * 0.62 * p.s;
    let color = cellColor(p.cell);
    const sun = opts.light.get(p.key);
    if (sun !== undefined)
      color = lerpColor(color, "#163a22", (1 - Math.round(sun * 8) / 8) * 0.55);
    if (opts.autumn > 0)
      color = lerpColor(
        color,
        hash(q, rr, 9) < 0.5 ? "#d9822b" : "#c4472a",
        Math.min(1, opts.autumn * (0.7 + 0.6 * hash(q, rr, 8))),
      );
    let g = greens.get(color);
    if (!g) greens.set(color, (g = new Path2D()));
    // Zoomed far out a leaf is a few pixels; one disc reads the same as three.
    const discs = r < 6 ? 1 : 3;
    for (let i = 0; i < discs; i++) {
      const a = hash(q, rr, i) * Math.PI * 2;
      const off = r * (i === 0 ? 0.1 : 0.42);
      const cx = p.sx + Math.cos(a) * off * p.s;
      const cy = p.sy + Math.sin(a) * off * p.s;
      const cr = lr * (discs === 1 ? 1.45 : 0.85 + 0.3 * hash(q, rr, i + 3));
      disc(shade, cx + r * 0.08, cy + r * 0.12, cr * 1.06);
      disc(g, cx, cy, cr);
      disc(light, cx - cr * 0.3, cy - cr * 0.35, cr * 0.45);
    }
  }
  ctx.fillStyle = "rgba(10,35,15,0.45)";
  ctx.fill(shade);
  for (const [color, g] of greens) {
    ctx.fillStyle = color;
    ctx.fill(g);
  }
  ctx.fillStyle = "rgba(235,255,200,0.16)";
  ctx.fill(light);
  if (opts.shimmerNow !== null) {
    const now = opts.shimmerNow;
    for (const p of leaves) {
      const ph = Math.sin(now * 0.004 + p.cell.q * 0.9 + p.cell.r * 1.7);
      if (ph <= 0) continue;
      ctx.fillStyle = `rgba(215,255,205,${ph * ph * 0.14})`;
      ctx.beginPath();
      ctx.arc(p.sx - r * 0.15, p.sy - r * 0.2, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Blossoms and fruit ──────────────────────────────────────────────────────
  for (const p of placed) {
    if (p.cell.type === "flower") drawBlossom(ctx, p, r);
    else if (p.cell.type === "fruit") drawFruit(ctx, p, r);
  }
}

// Bark comes in a handful of shades so neighbouring limbs share one fill: per-cell tints
// (water, energy) would split the wood into many paths whose antialiased seams show as a
// lattice. Water and energy have their own overlays; here only dying wood greys out.
function barkColor(c: Cell): string {
  if (c.type === "deadwood") return "#8B7355";
  const base =
    c.type === "reinforced wood" ? "#4e2b00" : below(c) ? "#5C3A1A" : "#6e4826";
  if (c.health >= 0.5) return base;
  return lerpColor(base, "#9E9E9E", Math.round((0.5 - c.health) * 8) / 4);
}

function disc(path: Path2D, x: number, y: number, rad: number): void {
  path.moveTo(x + rad, y);
  path.arc(x, y, rad, 0, Math.PI * 2);
}

// A tapered quad from a circle of radius ra at (ax, ay) to radius rb at (bx, by). Discs at
// both ends round the joints.
function limb(
  path: Path2D,
  ax: number,
  ay: number,
  ra: number,
  bx: number,
  by: number,
  rb: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Wind the quad the same way as arc() so overlapping shapes add up under the nonzero
  // fill rule instead of cancelling into holes. With this normal the quad's signed area
  // has the sign of (ra + rb), i.e. positive, matching a clockwise arc.
  const nx = dy / len;
  const ny = -dx / len;
  path.moveTo(ax + nx * ra, ay + ny * ra);
  path.lineTo(bx + nx * rb, by + ny * rb);
  path.lineTo(bx - nx * rb, by - ny * rb);
  path.lineTo(ax - nx * ra, ay - ny * ra);
  path.closePath();
}

function drawBlossom(
  ctx: CanvasRenderingContext2D,
  p: PlacedCell,
  r: number,
): void {
  const pr = r * 0.3 * p.s;
  const turn = hash(p.cell.q, p.cell.r, 5) * Math.PI;
  ctx.fillStyle = cellColor(p.cell);
  ctx.strokeStyle = "rgba(150,60,80,0.5)";
  ctx.lineWidth = Math.max(0.5, r * 0.04);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = turn + (i * Math.PI * 2) / 5;
    const cx = p.sx + Math.cos(a) * pr * 0.95;
    const cy = p.sy + Math.sin(a) * pr * 0.95;
    ctx.moveTo(cx + pr * 0.7, cy);
    ctx.arc(cx, cy, pr * 0.7, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffd75a";
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, pr * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function drawFruit(
  ctx: CanvasRenderingContext2D,
  p: PlacedCell,
  r: number,
): void {
  const m = Math.max(0, Math.min(1, p.cell.maturity ?? 1));
  const fr = r * (0.3 + 0.28 * m) * p.s;
  const cy = p.sy + fr * 0.25; // hangs a little below its twig
  ctx.fillStyle = "rgba(20,10,0,0.35)";
  ctx.beginPath();
  ctx.arc(p.sx + fr * 0.12, cy + fr * 0.15, fr * 1.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cellColor(p.cell);
  ctx.beginPath();
  ctx.arc(p.sx, cy, fr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.arc(p.sx - fr * 0.35, cy - fr * 0.35, fr * 0.28, 0, Math.PI * 2);
  ctx.fill();
}
