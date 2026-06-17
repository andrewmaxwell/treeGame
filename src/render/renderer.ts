import { hexToPixel, hexKey, HEX_NEIGHBORS } from '../sim/grid'
import type { Cell } from '../sim/cells'
import { surfaceR, type TerrainGen } from '../sim/terrain'
import { worldToScreen, type Camera } from './camera'
import { cellColor, overlayColor, type ResourceOverlay } from './colors'
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP } from '../sim/cells'

const OVERLAY_LIVING: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['tree', 'leaf', 'flower', 'fruit'])

export const BASE_RADIUS = 14  // world pixels per hex at zoom=1

// For each neighbor direction i in HEX_NEIGHBORS, the index of the hex edge that
// faces that neighbor. Edge e spans vertices e and (e+1)%6.
// In canvas (+y = down), vertex angles (π/3*i + π/6) point:
//   0→30°: lower-right, 1→90°: bottom, 2→150°: lower-left,
//   3→210°: upper-left, 4→270°: top, 5→330°: upper-right
// HEX_NEIGHBORS order: [right, left, lower-right, upper-left, upper-right, lower-left]
// Facing edges:         [    5,    2,           0,          3,           4,          1]
const DIR_TO_EDGE = [5, 2, 0, 3, 4, 1] as const

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
  validPlacements: Map<string, 'tree' | 'flower'>,
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
): void {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, width, height)

  const r = BASE_RADIUS * camera.zoom
  const hexW = BASE_RADIUS * Math.sqrt(3)
  const hexRowH = BASE_RADIUS * 1.5
  const inv = 1 / camera.zoom

  const worldLeft   = camera.x - width  * inv * 0.5
  const worldRight  = camera.x + width  * inv * 0.5
  const worldTop    = camera.y - height * inv * 0.5
  const worldBottom = camera.y + height * inv * 0.5

  const rMin = Math.floor(worldTop    / hexRowH) - 1
  const rMax = Math.ceil (worldBottom / hexRowH) + 1

  const treeCells: Array<{ cell: Cell; sx: number; sy: number }> = []

  // ── Pass 1: terrain ────────────────────────────────────────────────────────
  for (let rv = rMin; rv <= rMax; rv++) {
    const qMin = Math.floor(worldLeft  / hexW - rv / 2) - 1
    const qMax = Math.ceil (worldRight / hexW - rv / 2) + 1

    for (let q = qMin; q <= qMax; q++) {
      const key = hexKey(q, rv)
      const gameCell = cells.get(key)
      const cell = gameCell ?? terrain.get(q, rv)
      if (!cell) continue

      const { x: wx, y: wy } = hexToPixel(q, rv, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)

      if (gameCell) {
        // Soil/rock in game.cells came from simulation — render like terrain
        if (gameCell.type === 'soil' || gameCell.type === 'rock') {
          drawFilledHex(ctx, sx, sy, r, terrainFill(gameCell, overlay), 'rgba(0,0,0,0.3)', 0.5)
        } else {
          treeCells.push({ cell: gameCell, sx, sy })
        }
        continue
      }
      drawFilledHex(ctx, sx, sy, r, terrainFill(cell, overlay), 'rgba(0,0,0,0.3)', 0.5)
    }
  }

  // ── Pass 2: real game cells ────────────────────────────────────────────────
  for (const { cell, sx, sy } of treeCells) {
    const key = hexKey(cell.q, cell.r)
    if (overlay !== 'none' && OVERLAY_LIVING.has(cell.type)) {
      // Resource view: recolour by fullness; suppress stress/sun glyphs to keep it clean.
      const level = overlay === 'water' ? cell.water / CELL_WATER_CAP : cell.energy / CELL_ENERGY_CAP
      drawFilledHex(ctx, sx, sy, r, overlayColor(level, overlay), 'rgba(255,255,255,0.55)', 1.5)
    } else {
      drawFilledHex(ctx, sx, sy, r, cellColor(cell), 'rgba(255,255,255,0.55)', 1.5)
      drawStressTint(ctx, sx, sy, r, stress.get(key))
      if (cell.type === 'leaf' && leafLight.has(key)) {
        drawLeafSun(ctx, sx, sy, r, leafLight.get(key)!)
      }
    }
  }

  // ── Pass 2b: auto-leaf preview — faint ghost leaves where the canopy will grow ──
  if (leafPreview.size > 0 && overlay === 'none') {
    ctx.save()
    ctx.globalAlpha = 0.4
    for (const key of leafPreview) {
      const p = screenPosForKey(key, camera, width, height)
      if (p) drawFilledHex(ctx, p.sx, p.sy, r, '#4CAF50', 'rgba(120,200,120,0.5)', 1)
    }
    ctx.restore()
  }

  // ── Pass 3: valid placement highlights ────────────────────────────────────
  if (validPlacements.size > 0) {
    for (const [key, vpType] of validPlacements) {
      const comma = key.indexOf(',')
      const vq = parseInt(key.slice(0, comma))
      const vr = parseInt(key.slice(comma + 1))
      const { x: wx, y: wy } = hexToPixel(vq, vr, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)
      if (sx < -r * 2 || sx > width + r * 2 || sy < -r * 2 || sy > height + r * 2) continue
      // Underground wood placements are ROOT spots — over tan soil the faint above-ground
      // hint vanishes, so give roots a higher-contrast warm outline + fill so players see
      // they can dig down. Flower / above-ground wood keep the subtle dotted hint.
      const underground = vpType === 'tree' && vr >= surfaceR(vq)
      const stroke = vpType === 'flower' ? 'rgba(255,170,176,0.40)'
        : underground ? 'rgba(255,212,150,0.7)' : 'rgba(190,150,100,0.20)'
      hexPath(ctx, sx, sy, r * 0.92)
      ctx.fillStyle = vpType === 'flower' ? 'rgba(255,170,176,0.08)'
        : underground ? 'rgba(110,70,30,0.30)' : 'rgba(160,115,65,0.04)'
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = Math.max(0.5, camera.zoom)
      ctx.setLineDash([Math.max(1.5, 2 * camera.zoom), Math.max(2, 3 * camera.zoom)])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // ── Pass 4: staged cells at 50% opacity ────────────────────────────────────
  if (stagedCells.size > 0) {
    ctx.save()
    ctx.globalAlpha = 0.5
    for (const [, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)
      drawFilledHex(ctx, sx, sy, r, cellColor(cell), 'rgba(0,0,0,0)', 0)
    }
    ctx.restore()

    // ── Dashed group perimeter ─────────────────────────────────────────────
    // For each staged cell, draw only the edges whose neighbor is NOT staged.
    // This produces a clean outline around contiguous groups with no interior lines.
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = Math.max(1, 1.5 * camera.zoom)
    ctx.setLineDash([Math.max(3, 4 * camera.zoom), Math.max(2, 3 * camera.zoom)])
    ctx.lineCap = 'round'
    ctx.beginPath()

    for (const [, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)

      for (let d = 0; d < 6; d++) {
        const [dq, dr] = HEX_NEIGHBORS[d]
        if (stagedCells.has(hexKey(cell.q + dq, cell.r + dr))) continue  // interior edge

        const e = DIR_TO_EDGE[d]
        const a0 = (Math.PI / 3) * e + Math.PI / 6
        const a1 = (Math.PI / 3) * ((e + 1) % 6) + Math.PI / 6
        ctx.moveTo(sx + r * Math.cos(a0), sy + r * Math.sin(a0))
        ctx.lineTo(sx + r * Math.cos(a1), sy + r * Math.sin(a1))
      }
    }

    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    // Sun indicators on staged leaves — preview how much light a planned leaf would
    // get given the (real + staged) canopy above it. Stress tint previews how much
    // structural strain the planned wood would add before the player confirms.
    for (const [key, cell] of stagedCells) {
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)
      drawStressTint(ctx, sx, sy, r, stress.get(key))
      if (cell.type === 'leaf' && leafLight.has(key)) drawLeafSun(ctx, sx, sy, r, leafLight.get(key)!)
    }
  }

  // ── Pass 5: prune-removal preview (red) and inspected-cell outline (white) ───
  if (pruneSet.size > 0) {
    for (const key of pruneSet) {
      const p = screenPosForKey(key, camera, width, height)
      if (!p) continue
      drawFilledHex(ctx, p.sx, p.sy, r, 'rgba(220,60,60,0.42)', 'rgba(255,90,90,0.95)', Math.max(1, 1.5 * camera.zoom))
    }
  }
  if (inspectedKey) {
    const p = screenPosForKey(inspectedKey, camera, width, height)
    if (p) {
      hexPath(ctx, p.sx, p.sy, r)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(1.5, 2.5 * camera.zoom)
      ctx.stroke()
    }
  }

  // ── Pass 6: altitude ruler ──────────────────────────────────────────────────
  drawDepthRuler(ctx, width, height, camera, worldTop, worldBottom)
}

// A subtle left-edge gutter marking height above / depth below the surface every 10
// cells, so the player can read "depth 18 water table" or "10 cells tall" without
// counting (playtest request). Pinned to the screen's left edge (fixed x), world-mapped
// in y so the marks scroll with the camera. Drawn last, faint, to avoid adding noise.
const RULER_STEP = 10
function drawDepthRuler(
  ctx: CanvasRenderingContext2D,
  width: number, height: number,
  camera: Camera,
  worldTop: number, worldBottom: number,
): void {
  const hexRowH = BASE_RADIUS * 1.5
  const baseR = surfaceR(0)  // nominal surface row at the spawn column
  const rTop = Math.floor(worldTop / hexRowH)
  const rBot = Math.ceil(worldBottom / hexRowH)

  // First multiple-of-RULER_STEP offset from the surface at or above the top of view.
  const kStart = Math.ceil((rTop - baseR) / RULER_STEP)
  const kEnd = Math.floor((rBot - baseR) / RULER_STEP)

  ctx.save()
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  for (let k = kStart; k <= kEnd; k++) {
    const offset = k * RULER_STEP            // +offset = cells below surface (depth)
    const rv = baseR + offset
    const wy = hexRowH * rv
    const sy = (wy - camera.y) * camera.zoom + height / 2
    if (sy < 0 || sy > height) continue

    if (offset === 0) {
      // Surface line — the key reference; a touch more visible, drawn full-width.
      ctx.strokeStyle = 'rgba(150,205,150,0.22)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(width, sy); ctx.stroke()
      ctx.fillStyle = 'rgba(170,220,170,0.7)'
      ctx.fillText('ground', 16, sy - 7)
    } else {
      // Height (above) / depth (below) tick in the gutter only.
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(11, sy); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      const label = offset > 0 ? `${offset}↓` : `${-offset}↑`
      ctx.fillText(label, 16, sy)
    }
  }
  ctx.restore()
}

// Soil/rock fill — under the water overlay, soil shows its moisture on the same cyan
// ramp as the tree (so the soil-water field and root uptake read together); rock and the
// energy overlay fall back to the normal terrain colour.
function terrainFill(cell: Cell, overlay: ResourceOverlay): string {
  if (overlay === 'water' && cell.type === 'soil') {
    return overlayColor(cell.water / SOIL_WATER_CAP, 'water')
  }
  return cellColor(cell)
}

// Parse a "q,r" cell key to its on-screen center, or null if off-screen.
function screenPosForKey(
  key: string, camera: Camera, width: number, height: number,
): { sx: number; sy: number } | null {
  const comma = key.indexOf(',')
  const q = parseInt(key.slice(0, comma))
  const r = parseInt(key.slice(comma + 1))
  const { x: wx, y: wy } = hexToPixel(q, r, BASE_RADIUS)
  const { sx, sy } = worldToScreen(wx, wy, camera, width, height)
  const margin = BASE_RADIUS * camera.zoom * 2
  if (sx < -margin || sx > width + margin || sy < -margin || sy > height + margin) return null
  return { sx, sy }
}

// A small sun glyph at a leaf's upper-right, sized and brightened by how much light
// the leaf receives (0 = deeply shaded, 1 = full sun). Makes the otherwise-invisible
// canopy self-shading legible: stacked leaves visibly dim toward the bottom.
function drawLeafSun(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, level: number): void {
  const lvl = Math.max(0, Math.min(1, level))
  const x = cx + r * 0.42
  const y = cy - r * 0.42
  const disc = r * (0.12 + 0.16 * lvl)
  const alpha = 0.3 + 0.65 * lvl
  const rayLen = disc * (0.5 + 1.0 * lvl)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#FFD54A'
  ctx.strokeStyle = '#FFD54A'
  ctx.lineWidth = Math.max(0.5, r * 0.06)

  // rays
  if (rayLen > 0.6) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      const x0 = x + Math.cos(a) * disc * 1.3
      const y0 = y + Math.sin(a) * disc * 1.3
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + Math.cos(a) * rayLen, y0 + Math.sin(a) * rayLen)
      ctx.stroke()
    }
  }
  // disc
  ctx.beginPath()
  ctx.arc(x, y, disc, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// Subtle red overlay on an over-stressed wood cell, deepening with stress beyond the
// 0.8 warning line and saturating around the minor-storm threshold (1.2). Cells under
// the warning line (or with no stress entry) draw nothing.
const STRESS_WARN = 0.8
function drawStressTint(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stress: number | undefined): void {
  if (stress === undefined || stress <= STRESS_WARN) return
  const alpha = Math.min(0.38, 0.08 + (stress - STRESS_WARN) * 0.5)
  ctx.save()
  hexPath(ctx, cx, cy, r)
  ctx.fillStyle = `rgba(220,40,40,${alpha})`
  ctx.fill()
  ctx.restore()
}

function drawFilledHex(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  fill: string, stroke: string, lineWidth: number,
): void {
  hexPath(ctx, cx, cy, r)
  ctx.fillStyle = fill
  ctx.fill()
  if (lineWidth > 0) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6
    const px = cx + r * Math.cos(angle)
    const py = cy + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}
