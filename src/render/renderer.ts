import { hexToPixel, hexKey, HEX_NEIGHBORS } from "../sim/grid";
import type { Cell } from "../sim/cells";
import { surfaceR, type TerrainGen } from "../sim/terrain";
import { worldToScreen, type Camera } from "./camera";
import { cellColor, overlayColor, type ResourceOverlay } from "./colors";
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP } from "../sim/cells";
import { drawOrganicTree, type PlacedCell } from "./organic";
import {
  drawSky,
  drawWeather,
  grassColor,
  SKYLINE_STEP,
  type SceneEnv,
} from "./sky";

const OVERLAY_LIVING: ReadonlySet<Cell["type"]> = new Set<Cell["type"]>([
  "tree",
  "reinforced wood",
  "leaf",
  "flower",
  "fruit",
]);

export const BASE_RADIUS = 14; // world pixels per hex at zoom=1

// Playback animation inputs (render-only; the sim stays pure). `bornAt` maps a cell key to
// the timestamp it first appeared on screen, driving a grow-in "pop"; `shimmer` enables the
// subtle living-canopy leaf shimmer. Null outside animated frames so a plain redraw (e.g. a
// camera-only pan) skips the per-cell animation work entirely.
export interface SceneAnim {
  now: number;
  bornAt: Map<string, number>;
  shimmer: boolean;
}

// Grow-in pop duration (ms). Exported so the GameCanvas animation driver keeps the same
// window when it decides how long to keep redrawing after new growth appears.
export const GROW_MS = 320;

// Scale a freshly-born cell's radius over its grow-in: an ease-out-back that rises from a
// small seed, overshoots ~10%, and settles to 1.0 — the little "pop" as a cell appears.
function popScale(t: number): number {
  const c1 = 2.2;
  const c3 = c1 + 1;
  const u = t - 1;
  return Math.max(0.25, 1 + c3 * u * u * u + c1 * u * u);
}

// For each neighbor direction i in HEX_NEIGHBORS, the index of the hex edge that
// faces that neighbor. Edge e spans vertices e and (e+1)%6.
// In canvas (+y = down), vertex angles (π/3*i + π/6) point:
//   0→30°: lower-right, 1→90°: bottom, 2→150°: lower-left,
//   3→210°: upper-left, 4→270°: top, 5→330°: upper-right
// HEX_NEIGHBORS order: [right, left, lower-right, upper-left, upper-right, lower-left]
// Facing edges:         [    5,    2,           0,          3,           4,          1]
const DIR_TO_EDGE = [5, 2, 0, 3, 4, 1] as const;

export function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  cells: Map<string, Cell>,
  terrain: TerrainGen,
  stagedCells: Map<string, Cell>,
  // Hexes where the canopy will auto-grow leaves this season (planning preview), shown as
  // faint ghost leaves so the player sees the prospective canopy as they shape wood.
  leafPreview: Set<string>,
  validPlacements: Map<string, "tree" | "flower">,
  // Light level (0–1) per leaf cell key — drives the per-leaf sun indicator during
  // planning on the tree's existing leaves. Empty during playback.
  leafLight: Map<string, number>,
  // The inspected cell (white outline) and the set of cells a pending prune would
  // remove (red danger overlay). Both empty/null outside the inspector.
  inspectedKey: string | null,
  pruneSet: Set<string>,
  // Per wood-cell stress (load/strength). Cells over STRESS_WARN get a red tint — a
  // standing early warning and a live preview of staged growth's structural cost.
  stress: Map<string, number>,
  // Resource-flow overlay: recolour cells by water/energy fullness when not 'none'.
  overlay: ResourceOverlay,
  // Playback animation state (grow-in pop + leaf shimmer), or null for a plain redraw.
  anim: SceneAnim | null,
  // Season sky, sun and the weather currently being simulated.
  env: SceneEnv,
  // 0 = off; otherwise 0–1 pulse phase that makes a seedling's growth spots glow.
  hintPulse: number,
): void {
  const r = BASE_RADIUS * camera.zoom;
  const horizonY = (0 - camera.y) * camera.zoom + height / 2; // surfaceR(0) = row 0
  drawSky(ctx, width, height, horizonY, camera.zoom, env);
  const grass = grassColor(env);
  const hexW = BASE_RADIUS * Math.sqrt(3);
  const hexRowH = BASE_RADIUS * 1.5;
  const inv = 1 / camera.zoom;

  const worldLeft = camera.x - width * inv * 0.5;
  const worldRight = camera.x + width * inv * 0.5;
  const worldTop = camera.y - height * inv * 0.5;
  const worldBottom = camera.y + height * inv * 0.5;

  const rMin = Math.floor(worldTop / hexRowH) - 1;
  const rMax = Math.ceil(worldBottom / hexRowH) + 1;

  const treeCells: Array<{ cell: Cell; sx: number; sy: number }> = [];

  // ── Pass 1: terrain ────────────────────────────────────────────────────────
  for (let rv = rMin; rv <= rMax; rv++) {
    const qMin = Math.floor(worldLeft / hexW - rv / 2) - 1;
    const qMax = Math.ceil(worldRight / hexW - rv / 2) + 1;

    for (let q = qMin; q <= qMax; q++) {
      const key = hexKey(q, rv);
      const gameCell = cells.get(key);
      const cell = gameCell ?? terrain.get(q, rv);
      if (!cell) continue;

      const { x: wx, y: wy } = hexToPixel(q, rv, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);

      if (gameCell) {
        // Soil/rock in game.cells came from simulation — render like terrain
        if (gameCell.type === "soil" || gameCell.type === "rock") {
          drawFilledHex(
            ctx,
            sx,
            sy,
            r,
            terrainFill(gameCell, overlay),
            TERRAIN_STROKE,
            0.5,
          );
          if (rv === surfaceR(q) && overlay === "none")
            drawGrassCap(ctx, sx, sy, r, grass);
        } else {
          // Roots are drawn as thin limbs now, so the soil they grow through must show.
          if (rv >= surfaceR(q)) {
            const soil = terrain.get(q, rv);
            if (soil)
              drawFilledHex(
                ctx,
                sx,
                sy,
                r,
                cellColor(soil),
                TERRAIN_STROKE,
                0.5,
              );
            if (rv === surfaceR(q) && overlay === "none")
              drawGrassCap(ctx, sx, sy, r, grass);
          }
          treeCells.push({ cell: gameCell, sx, sy });
        }
        continue;
      }
      drawFilledHex(
        ctx,
        sx,
        sy,
        r,
        terrainFill(cell, overlay),
        TERRAIN_STROKE,
        0.5,
      );
      if (rv === surfaceR(q) && overlay === "none")
        drawGrassCap(ctx, sx, sy, r, grass);
    }
  }

  // Soil darkens with depth, so the underground reads as depth rather than a flat board.
  // Drawn before the tree so roots keep their colour; skipped in the resource views.
  if (overlay === "none" && horizonY < height) {
    const depthH = BASE_RADIUS * 1.5 * 40 * camera.zoom;
    const shade = ctx.createLinearGradient(0, horizonY, 0, horizonY + depthH);
    shade.addColorStop(0, "rgba(20,10,0,0)");
    shade.addColorStop(1, "rgba(20,10,0,0.5)");
    ctx.fillStyle = shade;
    const top = Math.max(0, horizonY - 4 * r);
    ctx.fillRect(0, top, width, height - top);
  }

  // Wind sway during playback: above-ground cells shift sideways in proportion to their
  // height, a breeze normally and a hard lean when a storm blows.
  const swayAmp = anim !== null ? (0.5 + env.wind * 6) * camera.zoom : 0;
  const swayLean = anim !== null ? env.wind * 3 * camera.zoom : 0;
  const swayT = anim !== null ? anim.now * (0.0022 + env.wind * 0.006) : 0;

  // ── Pass 2: real game cells ────────────────────────────────────────────────
  const placed: PlacedCell[] = [];
  for (const { cell, sy, sx: sx0 } of treeCells) {
    const key = hexKey(cell.q, cell.r);
    let sx = sx0;
    if (swayAmp > 0) {
      const h = surfaceR(cell.q) - cell.r;
      if (h > 0) {
        const k = Math.pow(h / 10, 1.3);
        sx += k * (swayAmp * Math.sin(swayT + cell.q * 0.15) + swayLean);
      }
    }
    // Grow-in pop: a just-appeared cell scales up from a seed to full size.
    let dr = r;
    if (anim !== null) {
      const born = anim.bornAt.get(key);
      if (born !== undefined) {
        const t = (anim.now - born) / GROW_MS;
        if (t < 1) dr = r * popScale(t);
      }
    }
    // In the normal view the tree is drawn as limbs and foliage (render/organic.ts);
    // the resource views keep flat hexes because there the cell is the data.
    if (
      overlay === "none" &&
      (OVERLAY_LIVING.has(cell.type) || cell.type === "deadwood")
    ) {
      // A staged cell replacing this one is drawn (as planned growth) below instead.
      if (!stagedCells.has(key)) placed.push({ cell, key, sx, sy, s: dr / r });
      continue;
    }
    // Resource view: recolour living cells by fullness; anything else keeps its colour.
    const fill = OVERLAY_LIVING.has(cell.type)
      ? overlayColor(
          overlay === "water"
            ? cell.water / CELL_WATER_CAP
            : cell.energy / CELL_ENERGY_CAP,
          overlay as "water" | "energy",
        )
      : cellColor(cell);
    drawFilledHex(ctx, sx, sy, dr, fill, "rgba(255,255,255,0.55)", 1.5);
  }
  // Planned growth joins the same tree, drawn pale: staged cells, and the canopy that
  // will leaf out on its own (the auto-leaf preview).
  let treeCellsMap = cells;
  if (overlay === "none" && (stagedCells.size > 0 || leafPreview.size > 0)) {
    treeCellsMap = withPlanned(cells, stagedCells, leafPreview);
    const margin = r * 2;
    const addGhost = (cell: Cell, key: string) => {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);
      if (sx < -margin || sx > width + margin) return;
      if (sy < -margin || sy > height + margin) return;
      placed.push({ cell, key, sx, sy, s: 1, ghost: true });
    };
    for (const [key, cell] of stagedCells)
      if (OVERLAY_LIVING.has(cell.type)) addGhost(cell, key);
    for (const key of leafPreview)
      if (!stagedCells.has(key)) addGhost(treeCellsMap.get(key)!, key);
  }
  if (placed.length > 0) {
    drawOrganicTree(ctx, placed, treeCellsMap, {
      r,
      light: leafLight,
      autumn: env.season === "fall" ? 0.25 + 0.75 * env.seasonT : 0,
      shimmerNow:
        anim !== null && anim.shimmer && r >= RECT_HEX_R ? anim.now : null,
    });
    for (const p of placed) {
      const s = stress.get(p.key);
      if (s !== undefined && s > STRESS_WARN) {
        ctx.fillStyle = `rgba(230,40,40,${Math.min(0.6, 0.15 + (s - STRESS_WARN) * 0.8)})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ── Pass 3: valid placement highlights ────────────────────────────────────
  if (validPlacements.size > 0) {
    for (const [key, vpType] of validPlacements) {
      const comma = key.indexOf(",");
      const vq = parseInt(key.slice(0, comma));
      const vr = parseInt(key.slice(comma + 1));
      const { x: wx, y: wy } = hexToPixel(vq, vr, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);
      if (
        sx < -r * 2 ||
        sx > width + r * 2 ||
        sy < -r * 2 ||
        sy > height + r * 2
      )
        continue;
      // Underground wood placements are ROOT spots — over tan soil the faint above-ground
      // hint vanishes, so give roots a higher-contrast warm outline + fill so players see
      // they can dig down. Above ground the spots sit on sky and foliage, so they get a
      // light dashed hex and a bud at the centre; flower spots the same in pink.
      const underground = vpType === "tree" && vr >= surfaceR(vq);
      // Spots inside the canopy (wood can replace a leaf) get only the bud: a dashed hex
      // on every leaf would cover the canopy in grid.
      const inCanopy = cells.get(key)?.type === "leaf";
      const stroke =
        vpType === "flower"
          ? "rgba(255,190,200,0.75)"
          : underground
            ? "rgba(255,212,150,0.7)"
            : "rgba(255,248,225,0.6)";
      if (hintPulse > 0) {
        hexPath(ctx, sx, sy, r * (0.86 + 0.06 * hintPulse));
        ctx.fillStyle = `rgba(255,226,150,${0.12 + 0.22 * hintPulse})`;
        ctx.fill();
      }
      if (inCanopy && r >= RECT_HEX_R) {
        ctx.fillStyle = "rgba(255,246,220,0.8)";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.5, r * 0.13), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      hexPath(ctx, sx, sy, r * 0.92);
      ctx.fillStyle =
        vpType === "flower"
          ? "rgba(255,170,176,0.12)"
          : underground
            ? "rgba(110,70,30,0.30)"
            : "rgba(255,248,225,0.10)";
      ctx.fill();
      if (!underground && r >= RECT_HEX_R) {
        ctx.fillStyle =
          vpType === "flower"
            ? "rgba(255,170,190,0.9)"
            : "rgba(255,246,220,0.85)";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.5, r * 0.14), 0, Math.PI * 2);
        ctx.fill();
        hexPath(ctx, sx, sy, r * 0.92); // restore the hex for the dashed stroke
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.5, camera.zoom);
      ctx.setLineDash([
        Math.max(1.5, 2 * camera.zoom),
        Math.max(2, 3 * camera.zoom),
      ]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Pass 4: staged cells as hexes, in the resource views only (the normal view draws
  // them as pale growth on the tree) ──────────────────────────────────────────────
  if (stagedCells.size > 0 && overlay !== "none") {
    ctx.save();
    ctx.globalAlpha = 0.7;
    for (const [, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);
      drawFilledHex(ctx, sx, sy, r, cellColor(cell), "rgba(0,0,0,0)", 0);
    }
    ctx.restore();

    // ── Dashed group perimeter ─────────────────────────────────────────────
    // For each staged cell, draw only the edges whose neighbor is NOT staged.
    // This produces a clean outline around contiguous groups with no interior lines.
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, 1.5 * camera.zoom);
    ctx.setLineDash([
      Math.max(3, 4 * camera.zoom),
      Math.max(2, 3 * camera.zoom),
    ]);
    ctx.lineCap = "round";
    ctx.beginPath();

    for (const [, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);

      for (let d = 0; d < 6; d++) {
        const [dq, dr] = HEX_NEIGHBORS[d];
        if (stagedCells.has(hexKey(cell.q + dq, cell.r + dr))) continue; // interior edge

        const e = DIR_TO_EDGE[d];
        const a0 = (Math.PI / 3) * e + Math.PI / 6;
        const a1 = (Math.PI / 3) * ((e + 1) % 6) + Math.PI / 6;
        ctx.moveTo(sx + r * Math.cos(a0), sy + r * Math.sin(a0));
        ctx.lineTo(sx + r * Math.cos(a1), sy + r * Math.sin(a1));
      }
    }

    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Sun indicators on staged leaves — preview how much light a planned leaf would
    // get given the (real + staged) canopy above it. Stress tint previews how much
    // structural strain the planned wood would add before the player confirms.
    for (const [key, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS);
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height);
      drawStressTint(ctx, sx, sy, r, stress.get(key));
      if (cell.type === "leaf" && leafLight.has(key))
        drawLeafSun(ctx, sx, sy, r, leafLight.get(key)!);
    }
  }

  // ── Pass 5: prune-removal preview (red) and inspected-cell outline (white) ───
  if (pruneSet.size > 0) {
    for (const key of pruneSet) {
      const p = screenPosForKey(key, camera, width, height);
      if (!p) continue;
      drawFilledHex(
        ctx,
        p.sx,
        p.sy,
        r,
        "rgba(220,60,60,0.42)",
        "rgba(255,90,90,0.95)",
        Math.max(1, 1.5 * camera.zoom),
      );
    }
  }
  if (inspectedKey) {
    const p = screenPosForKey(inspectedKey, camera, width, height);
    if (p) {
      hexPath(ctx, p.sx, p.sy, r);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(1.5, 2.5 * camera.zoom);
      ctx.stroke();
    }
  }

  // ── Pass 6: rain / snow (over the tree, clipped to the sky) + lightning ─────
  if (env.rain > 0.02 || env.flash > 0.01)
    drawWeather(ctx, width, height, skyline(width, height, camera), env);

  // ── Pass 7: altitude ruler ──────────────────────────────────────────────────
  drawDepthRuler(ctx, width, height, camera, worldTop, worldBottom);
}

// A subtle left-edge gutter marking height above / depth below the surface every 10
// cells, so the player can read "depth 18 water table" or "10 cells tall" without
// counting (playtest request). Pinned to the screen's left edge (fixed x), world-mapped
// in y so the marks scroll with the camera. Drawn last, faint, to avoid adding noise.
const RULER_STEP = 10;
function drawDepthRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  worldTop: number,
  worldBottom: number,
): void {
  const hexRowH = BASE_RADIUS * 1.5;
  const baseR = surfaceR(0); // nominal surface row at the spawn column
  const rTop = Math.floor(worldTop / hexRowH);
  const rBot = Math.ceil(worldBottom / hexRowH);

  // First multiple-of-RULER_STEP offset from the surface at or above the top of view.
  const kStart = Math.ceil((rTop - baseR) / RULER_STEP);
  const kEnd = Math.floor((rBot - baseR) / RULER_STEP);

  ctx.save();
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (let k = kStart; k <= kEnd; k++) {
    const offset = k * RULER_STEP; // +offset = cells below surface (depth)
    const rv = baseR + offset;
    const wy = hexRowH * rv;
    const sy = (wy - camera.y) * camera.zoom + height / 2;
    if (sy < 0 || sy > height) continue;

    if (offset === 0) {
      // Surface line — the key reference; a touch more visible, drawn full-width.
      ctx.strokeStyle = "rgba(150,205,150,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
      ctx.stroke();
      ctx.fillStyle = "rgba(170,220,170,0.7)";
      ctx.fillText("ground", 16, sy - 7);
    } else {
      // Height (above) / depth (below) tick in the gutter only.
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(11, sy);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      const label = offset > 0 ? `${offset}↓` : `${-offset}↑`;
      ctx.fillText(label, 16, sy);
    }
  }
  ctx.restore();
}

const TERRAIN_STROKE = "rgba(0,0,0,0.18)";

// The top soil row wears the season: green in spring, straw in a drought, snow in winter.
// Fills the hex's upper half (the three top vertices down to just above centre).
function drawGrassCap(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  if (r < RECT_HEX_R) {
    ctx.fillRect(cx - r * 0.95, cy - r * 0.9, r * 1.9, r * 0.75);
    return;
  }
  const hw = r * HEX_VERT[0][0]; // half-width (cos 30°)
  ctx.beginPath();
  ctx.moveTo(cx + hw, cy - r * 0.05);
  ctx.lineTo(cx + hw, cy - r * 0.5);
  ctx.lineTo(cx, cy - r);
  ctx.lineTo(cx - hw, cy - r * 0.5);
  ctx.lineTo(cx - hw, cy - r * 0.05);
  ctx.closePath();
  ctx.fill();
}

// Screen y of the ground's top edge every SKYLINE_STEP px, for clipping rain to the sky.
function skyline(width: number, height: number, camera: Camera): Float32Array {
  const hexW = BASE_RADIUS * Math.sqrt(3);
  const n = Math.ceil(width / SKYLINE_STEP) + 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const wx = camera.x + (i * SKYLINE_STEP - width / 2) / camera.zoom;
    let q = Math.round(wx / hexW);
    q = Math.round(wx / hexW - surfaceR(q) / 2);
    const wy = BASE_RADIUS * 1.5 * surfaceR(q) - BASE_RADIUS * 0.7;
    out[i] = Math.min(height, (wy - camera.y) * camera.zoom + height / 2);
  }
  return out;
}

// Soil/rock fill — under the water overlay, soil shows its moisture on the same cyan
// ramp as the tree (so the soil-water field and root uptake read together); rock and the
// energy overlay fall back to the normal terrain colour.
function terrainFill(cell: Cell, overlay: ResourceOverlay): string {
  if (overlay === "water" && cell.type === "soil") {
    return overlayColor(cell.water / SOIL_WATER_CAP, "water");
  }
  return cellColor(cell);
}

// Parse a "q,r" cell key to its on-screen center, or null if off-screen.
function screenPosForKey(
  key: string,
  camera: Camera,
  width: number,
  height: number,
): { sx: number; sy: number } | null {
  const comma = key.indexOf(",");
  const q = parseInt(key.slice(0, comma));
  const r = parseInt(key.slice(comma + 1));
  const { x: wx, y: wy } = hexToPixel(q, r, BASE_RADIUS);
  const { sx, sy } = worldToScreen(wx, wy, camera, width, height);
  const margin = BASE_RADIUS * camera.zoom * 2;
  if (
    sx < -margin ||
    sx > width + margin ||
    sy < -margin ||
    sy > height + margin
  )
    return null;
  return { sx, sy };
}

// A small sun glyph at a leaf's upper-right, sized and brightened by how much light
// the leaf receives (0 = deeply shaded, 1 = full sun). Makes the otherwise-invisible
// canopy self-shading legible: stacked leaves visibly dim toward the bottom.
function drawLeafSun(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  level: number,
): void {
  const lvl = Math.max(0, Math.min(1, level));
  const x = cx + r * 0.42;
  const y = cy - r * 0.42;
  const disc = r * (0.12 + 0.16 * lvl);
  const alpha = 0.3 + 0.65 * lvl;
  const rayLen = disc * (0.5 + 1.0 * lvl);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#FFD54A";
  ctx.strokeStyle = "#FFD54A";
  ctx.lineWidth = Math.max(0.5, r * 0.06);

  // rays
  if (rayLen > 0.6) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x0 = x + Math.cos(a) * disc * 1.3;
      const y0 = y + Math.sin(a) * disc * 1.3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * rayLen, y0 + Math.sin(a) * rayLen);
      ctx.stroke();
    }
  }
  // disc
  ctx.beginPath();
  ctx.arc(x, y, disc, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Subtle red overlay on an over-stressed wood cell, deepening with stress beyond the
// 0.8 warning line and saturating around the minor-storm threshold (1.2). Cells under
// the warning line (or with no stress entry) draw nothing.
const STRESS_WARN = 0.8;
function drawStressTint(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  stress: number | undefined,
): void {
  if (stress === undefined || stress <= STRESS_WARN) return;
  const alpha = Math.min(0.38, 0.08 + (stress - STRESS_WARN) * 0.5);
  ctx.save();
  hexPath(ctx, cx, cy, r);
  ctx.fillStyle = `rgba(220,40,40,${alpha})`;
  ctx.fill();
  ctx.restore();
}

// Below this on-screen radius (px), a hex is only a few pixels: its 1px outline is
// invisible and a 6-segment path is indistinguishable from a filled rectangle. At that
// size we draw a single fillRect (no path, no stroke), which is dramatically cheaper than
// beginPath + 6 lineTo + fill + stroke — the dominant cost when zoomed all the way out on
// a big tree (drawScene paints ~25-30k tiny hexes/frame). The rect is sized slightly over
// the hex's bbox so the cells still tile into solid masses with no gaps. Above the
// threshold (normal/zoomed-in play) the full hex path + gap stroke is used as before.
const RECT_HEX_R = 6;

function drawFilledHex(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  stroke: string,
  lineWidth: number,
): void {
  ctx.fillStyle = fill;
  if (r < RECT_HEX_R) {
    const w = r * 1.9;
    const h = r * 1.75;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    return;
  }
  hexPath(ctx, cx, cy, r);
  ctx.fill();
  if (lineWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

// The 6 pointy-top vertex unit offsets (cos/sin of π/3·i + π/6) are constant, so compute
// them once instead of 12 trig calls per hex per frame.
const HEX_VERT: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: 6 },
  (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return [Math.cos(a), Math.sin(a)] as const;
  },
);

function hexPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [c, s] = HEX_VERT[i];
    const px = cx + r * c;
    const py = cy + r * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// Real cells plus planned growth (staged cells, and preview leaves as healthy leaf cells),
// so the organic pass sizes limbs and hangs leaves as if the plan had happened. Cached on
// the three inputs' identities, which only change when the plan or a frame does.
let plannedCache: {
  cells: Map<string, Cell>;
  staged: Map<string, Cell>;
  preview: Set<string>;
  merged: Map<string, Cell>;
} | null = null;
function withPlanned(
  cells: Map<string, Cell>,
  staged: Map<string, Cell>,
  preview: Set<string>,
): Map<string, Cell> {
  const c = plannedCache;
  if (c && c.cells === cells && c.staged === staged && c.preview === preview)
    return c.merged;
  const merged = new Map(cells);
  for (const [k, cell] of staged) merged.set(k, cell);
  for (const k of preview) {
    if (staged.has(k)) continue;
    const comma = k.indexOf(",");
    const q = parseInt(k.slice(0, comma));
    const r = parseInt(k.slice(comma + 1));
    merged.set(k, {
      q,
      r,
      type: "leaf",
      water: CELL_WATER_CAP * 0.6,
      energy: CELL_ENERGY_CAP * 0.5,
      health: 1,
      rot: 0,
      age: 0,
    });
  }
  plannedCache = { cells, staged, preview, merged };
  return merged;
}
