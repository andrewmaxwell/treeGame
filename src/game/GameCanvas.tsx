import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, type RefObject } from 'react'
import { createCamera, clampZoom, screenToWorld, type Camera } from '../render/camera'
import { drawScene, BASE_RADIUS } from '../render/renderer'
import { computeLight } from '../sim/simulate'
import { SEASON_PARAMS } from '../sim/weather'
import { pixelToHex, hexToPixel } from '../sim/grid'
import { surfaceR } from '../sim/terrain'
import type { Cell } from '../sim/cells'
import type { GameState } from './state'
import { getValidPlacements, type PlanningState, type PlacementMode } from './planning'

const EMPTY_LIGHT = new Map<string, number>()

export interface GameCanvasHandle {
  requestDraw: () => void
  triggerShake: () => void
}

interface GameCanvasProps {
  gameRef:    RefObject<GameState>
  planningRef: RefObject<PlanningState>
  modeRef:    RefObject<PlacementMode>
  isPlaying:  boolean
  onTap: (q: number, r: number) => void
}

// Light map over the real + staged canopy, for the per-leaf sun indicators. Computed
// fresh on each (change-driven) planning render — cheap and always reflects staging.
function computePlanningLight(game: GameState, planning: PlanningState): Map<string, number> {
  if (planning.stagedCells.size === 0 && game.cells.size === 0) return EMPTY_LIGHT
  const merged = new Map<string, Cell>(game.cells)
  for (const [k, c] of planning.stagedCells) merged.set(k, c)
  return computeLight({ ...game, cells: merged }, SEASON_PARAMS[game.season].sunAngleDeg)
}

function makeCamera(): Camera {
  const cam = createCamera()
  const seedWorldY = hexToPixel(0, surfaceR(0), BASE_RADIUS).y
  cam.x = 0
  cam.y = seedWorldY + BASE_RADIUS * 1.5 * 5
  return cam
}

export const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(
  function GameCanvas({ gameRef, planningRef, modeRef, isPlaying, onTap }, ref) {
    const canvasRef    = useRef<HTMLCanvasElement>(null)
    const cameraRef    = useRef<Camera>(makeCamera())
    const rafRef       = useRef<number>(0)
    const dirtyRef     = useRef(true)
    const cssSizeRef   = useRef({ width: 0, height: 0 })
    const shakeUntilRef = useRef(0)  // performance.now() deadline

    const panRef   = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false })
    const pinchRef = useRef({ active: false, lastDist: 0 })

    // Expose handle to parent
    useImperativeHandle(ref, () => ({
      requestDraw: () => { dirtyRef.current = true },
      triggerShake: () => { shakeUntilRef.current = performance.now() + 350 },
    }), [])

    // ── Render loop ───────────────────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')!

      function loop(now: number) {
        rafRef.current = requestAnimationFrame(loop)
        const isShaking = now < shakeUntilRef.current
        if (!dirtyRef.current && !isShaking) return
        dirtyRef.current = false

        const { width, height } = cssSizeRef.current
        if (width === 0 || height === 0) return

        // Shake: oscillate camera.x slightly, amplitude decays to zero
        const cam = cameraRef.current
        let drawCam = cam
        if (isShaking) {
          const frac = (shakeUntilRef.current - now) / 350
          const shakeX = Math.sin(now * 0.03) * 4 * frac / cam.zoom
          drawCam = { ...cam, x: cam.x + shakeX }
          dirtyRef.current = true  // keep looping until shake expires
        }

        const g = gameRef.current
        const p = planningRef.current
        const m = modeRef.current
        if (g && p && m) {
          // During playback, hide placement highlights and staged cells
          const vp = isPlaying ? new Map() : getValidPlacements(m, g, p)
          const staged = isPlaying ? new Map() : p.stagedCells
          const shed   = isPlaying ? new Set<string>() : p.shedMarked
          // During planning, show how much sun each leaf (real + staged) receives
          // under the current season's sun angle, including staged-canopy shading.
          const leafLight = isPlaying ? EMPTY_LIGHT : computePlanningLight(g, p)
          drawScene(ctx, width, height, drawCam, g.cells, g.terrain, staged, shed, vp, leafLight)
        }
      }

      rafRef.current = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(rafRef.current)
    }, [gameRef, planningRef, modeRef, isPlaying])

    // ── Resize observer ───────────────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const obs = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect
        cssSizeRef.current = { width, height }
        canvas.width  = Math.round(width  * devicePixelRatio)
        canvas.height = Math.round(height * devicePixelRatio)
        const ctx = canvas.getContext('2d')!
        ctx.scale(devicePixelRatio, devicePixelRatio)
        dirtyRef.current = true
      })
      obs.observe(canvas)
      return () => obs.disconnect()
    }, [])

    // ── Mouse ─────────────────────────────────────────────────────────────────
    const onMouseDown = useCallback((e: React.MouseEvent) => {
      panRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY, moved: false }
    }, [])

    const onMouseMove = useCallback((e: React.MouseEvent) => {
      const pan = panRef.current
      if (!pan.dragging) return
      const dx = e.clientX - pan.lastX
      const dy = e.clientY - pan.lastY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pan.moved = true
      cameraRef.current.x -= dx / cameraRef.current.zoom
      cameraRef.current.y -= dy / cameraRef.current.zoom
      pan.lastX = e.clientX; pan.lastY = e.clientY
      dirtyRef.current = true
    }, [])

    const onMouseUp = useCallback((e: React.MouseEvent) => {
      const pan = panRef.current
      pan.dragging = false
      if (!pan.moved) {
        const rect = canvasRef.current!.getBoundingClientRect()
        const sx = e.clientX - rect.left
        const sy = e.clientY - rect.top
        const { wx, wy } = screenToWorld(sx, sy, cameraRef.current, rect.width, rect.height)
        const { q, r }   = pixelToHex(wx, wy, BASE_RADIUS)
        onTap(q, r)
      }
    }, [onTap])

    // Leaving the canvas only cancels an in-progress drag — it must NOT be treated as
    // a tap, or moving the cursor onto the HUD would fire a phantom (often rejected,
    // hence shaking) placement at the exit point.
    const onMouseLeave = useCallback(() => {
      panRef.current.dragging = false
    }, [])

    // ── Wheel zoom (non-passive) ──────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current!
      function onWheel(e: WheelEvent) {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const sx   = e.clientX - rect.left
        const sy   = e.clientY - rect.top
        const cam  = cameraRef.current
        const { wx: wx0, wy: wy0 } = screenToWorld(sx, sy, cam, rect.width, rect.height)
        cam.zoom = clampZoom(cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
        const { wx: wx1, wy: wy1 } = screenToWorld(sx, sy, cam, rect.width, rect.height)
        cam.x += wx0 - wx1; cam.y += wy0 - wy1
        dirtyRef.current = true
      }
      canvas.addEventListener('wheel', onWheel, { passive: false })
      return () => canvas.removeEventListener('wheel', onWheel)
    }, [])

    // ── Touch ─────────────────────────────────────────────────────────────────
    const onTouchStart = useCallback((e: React.TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0]
        panRef.current = { dragging: true, lastX: t.clientX, lastY: t.clientY, moved: false }
        pinchRef.current.active = false
      } else if (e.touches.length === 2) {
        panRef.current.dragging = false
        pinchRef.current = { active: true, lastDist: touchDist(e.touches[0], e.touches[1]) }
      }
    }, [])

    const onTouchMove = useCallback((e: React.TouchEvent) => {
      e.preventDefault()
      if (e.touches.length === 1 && panRef.current.dragging) {
        const t = e.touches[0]
        const dx = t.clientX - panRef.current.lastX
        const dy = t.clientY - panRef.current.lastY
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panRef.current.moved = true
        cameraRef.current.x -= dx / cameraRef.current.zoom
        cameraRef.current.y -= dy / cameraRef.current.zoom
        panRef.current.lastX = t.clientX; panRef.current.lastY = t.clientY
        dirtyRef.current = true
      } else if (e.touches.length === 2 && pinchRef.current.active) {
        const dist   = touchDist(e.touches[0], e.touches[1])
        const factor = dist / pinchRef.current.lastDist
        pinchRef.current.lastDist = dist
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
        const rect  = canvasRef.current!.getBoundingClientRect()
        const cam   = cameraRef.current
        const { wx: wx0, wy: wy0 } = screenToWorld(midX - rect.left, midY - rect.top, cam, rect.width, rect.height)
        cam.zoom = clampZoom(cam.zoom * factor)
        const { wx: wx1, wy: wy1 } = screenToWorld(midX - rect.left, midY - rect.top, cam, rect.width, rect.height)
        cam.x += wx0 - wx1; cam.y += wy0 - wy1
        dirtyRef.current = true
      }
    }, [])

    const onTouchEnd = useCallback((e: React.TouchEvent) => {
      if (e.touches.length === 0) {
        const pan = panRef.current
        if (pan.dragging && !pan.moved) {
          const touch = e.changedTouches[0]
          const rect  = canvasRef.current!.getBoundingClientRect()
          const { wx, wy } = screenToWorld(touch.clientX - rect.left, touch.clientY - rect.top, cameraRef.current, rect.width, rect.height)
          const { q, r } = pixelToHex(wx, wy, BASE_RADIUS)
          onTap(q, r)
        }
        pan.dragging = false
        pinchRef.current.active = false
      } else if (e.touches.length === 1) {
        pinchRef.current.active = false
        const t = e.touches[0]
        panRef.current = { dragging: true, lastX: t.clientX, lastY: t.clientY, moved: false }
      }
    }, [onTap])

    return (
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      />
    )
  }
)

function touchDist(a: React.Touch, b: React.Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}
