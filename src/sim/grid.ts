// Pointy-top axial hex grid math
// +r = downward, -r = upward, ±q = left/right

export const HEX_NEIGHBORS: [number, number][] = [
  [1, 0], [-1, 0],
  [0, 1], [0, -1],
  [1, -1], [-1, 1],
]

export function hexKey(q: number, r: number): string {
  return `${q},${r}`
}

export function hexNeighbors(q: number, r: number): [number, number][] {
  return HEX_NEIGHBORS.map(([dq, dr]) => [q + dq, r + dr] as [number, number])
}

// Convert axial (q, r) to pixel center for pointy-top hexagons
export function hexToPixel(q: number, r: number, radius: number): { x: number; y: number } {
  // Pointy-top: x = radius * sqrt(3) * (q + r/2), y = radius * 3/2 * r
  const x = radius * Math.sqrt(3) * (q + r / 2)
  const y = radius * 1.5 * r
  return { x, y }
}

// Convert pixel (px, py) to nearest axial hex coordinate
export function pixelToHex(px: number, py: number, radius: number): { q: number; r: number } {
  // Inverse of hexToPixel for pointy-top
  const r = py / (radius * 1.5)
  const q = px / (radius * Math.sqrt(3)) - r / 2
  return hexRound(q, r)
}

function hexRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  let rs = Math.round(s)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) {
    rq = -rr - rs
  } else if (dr > ds) {
    rr = -rq - rs
  }
  return { q: rq, r: rr }
}

// Pixel-space horizontal distance (x component only), used for lateral offset
export function hexPixelX(q: number, r: number): number {
  return q + r / 2
}

export function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2
}
