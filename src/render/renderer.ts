import { hexToPixel, hexKey, HEX_NEIGHBORS } from '../sim/grid'
import type { Cell } from '../sim/cells'
import type { TerrainGen } from '../sim/terrain'
import { worldToScreen, type Camera } from './camera'
import { cellColor } from './colors'

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
  shedMarked: Set<string>,
  validPlacements: Map<string, 'tree' | 'leaf'>,
  // Light level (0–1) per leaf cell key — drives the per-leaf sun indicator during
  // planning. Empty during playback. Includes staged leaves (prospective shading).
  leafLight: Map<string, number>,
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
          drawFilledHex(ctx, sx, sy, r, cellColor(gameCell), 'rgba(0,0,0,0.3)', 0.5)
        } else {
          treeCells.push({ cell: gameCell, sx, sy })
        }
        continue
      }
      drawFilledHex(ctx, sx, sy, r, cellColor(cell), 'rgba(0,0,0,0.3)', 0.5)
    }
  }

  // ── Pass 2: real game cells ────────────────────────────────────────────────
  for (const { cell, sx, sy } of treeCells) {
    const key = hexKey(cell.q, cell.r)
    const isShedMarked = shedMarked.has(key)
    if (isShedMarked) {
      // Draw wilting yellow tint
      drawFilledHex(ctx, sx, sy, r, '#C8A020', 'rgba(0,0,0,0.3)', 0.5)
      drawShedX(ctx, sx, sy, r)
    } else {
      drawFilledHex(ctx, sx, sy, r, cellColor(cell), 'rgba(255,255,255,0.55)', 1.5)
      if (cell.type === 'leaf' && leafLight.has(key)) {
        drawLeafSun(ctx, sx, sy, r, leafLight.get(key)!)
      }
    }
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
      const fill   = vpType === 'leaf' ? 'rgba(76,175,80,0.09)'   : 'rgba(160,115,65,0.09)'
      const stroke = vpType === 'leaf' ? 'rgba(76,175,80,0.28)'   : 'rgba(180,130,80,0.28)'
      drawFilledHex(ctx, sx, sy, r, fill, stroke, Math.max(0.5, camera.zoom))
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
    // get given the (real + staged) canopy above it.
    for (const [key, cell] of stagedCells) {
      if (cell.type !== 'leaf' || !leafLight.has(key)) continue
      const { x: wx, y: wy } = hexToPixel(cell.q, cell.r, BASE_RADIUS)
      const { sx, sy } = worldToScreen(wx, wy, camera, width, height)
      drawLeafSun(ctx, sx, sy, r, leafLight.get(key)!)
    }
  }
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

function drawShedX(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const s = r * 0.35
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = Math.max(1, r * 0.12)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s)
  ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s)
  ctx.stroke()
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
