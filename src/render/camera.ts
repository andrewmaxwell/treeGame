// Camera: tracks pan offset and zoom level, converts between world and screen space

export interface Camera {
  x: number       // world-space x at screen center
  y: number       // world-space y at screen center
  zoom: number    // pixels per unit (multiplied on top of hex radius)
}

export function createCamera(): Camera {
  return { x: 0, y: 0, zoom: 1 }
}

// World → screen
export function worldToScreen(
  wx: number, wy: number,
  camera: Camera,
  screenW: number, screenH: number
): { sx: number; sy: number } {
  return {
    sx: (wx - camera.x) * camera.zoom + screenW / 2,
    sy: (wy - camera.y) * camera.zoom + screenH / 2,
  }
}

// Screen → world
export function screenToWorld(
  sx: number, sy: number,
  camera: Camera,
  screenW: number, screenH: number
): { wx: number; wy: number } {
  return {
    wx: (sx - screenW / 2) / camera.zoom + camera.x,
    wy: (sy - screenH / 2) / camera.zoom + camera.y,
  }
}

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 4.0

export function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
}
