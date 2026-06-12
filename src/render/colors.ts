import type { Cell } from '../sim/cells'
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP } from '../sim/cells'
import { surfaceR } from '../sim/terrain'

export function cellColor(cell: Cell): string {
  switch (cell.type) {
    case 'soil': {
      const t = Math.max(0, Math.min(1, cell.water / SOIL_WATER_CAP))
      return lerpColor('#C4A46B', '#8B6340', t)
    }
    case 'rock':
      return '#6B6B6B'
    case 'tree': {
      const base = cell.r >= surfaceR(cell.q) ? '#5C3A1A' : '#7B5230'
      const c = energyTint(waterTint(base, cell.water, CELL_WATER_CAP), cell.energy)
      return healthTint(c, cell.health)
    }
    case 'leaf': {
      const c = energyTint(waterTint('#4CAF50', cell.water, CELL_WATER_CAP), cell.energy)
      return healthTint(c, cell.health)
    }
    case 'flower':
      return healthTint('#FFAAB0', cell.health)
    case 'fruit':
      return healthTint('#E8703A', cell.health)
    case 'deadwood':
      return '#8B7355'
  }
}

// Shift toward warm amber with stored energy. Subtle (≤15%): water (blue) reads as
// the dominant resource; blue + amber at full health lands near the warm base brown.
function energyTint(base: string, energy: number): string {
  const t = Math.max(0, Math.min(1, energy / CELL_ENERGY_CAP))
  return lerpColor(base, '#D4A017', t * 0.15)
}

// Below 0.5 health, desaturate toward gray so a dying limb visibly grays out before
// it dies. (At health 0 the cell has already converted to deadwood / dropped.)
function healthTint(base: string, health: number): string {
  if (health >= 0.5) return base
  const t = Math.max(0, Math.min(1, (0.5 - health) / 0.5))
  return lerpColor(base, '#9E9E9E', t)
}

// Blend base color toward blue at full hydration; toward gray when dry.
function waterTint(base: string, water: number, cap: number): string {
  const t = Math.max(0, Math.min(1, water / cap))
  let color = lerpColor(base, '#4A90D9', t * 0.20)
  if (water <= 0) color = lerpColor(color, '#888888', 0.30)
  return color
}

function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseColor(a)
  const [r2, g2, b2] = parseColor(b)
  return `rgb(${lerp(r1, r2, t)},${lerp(g1, g2, t)},${lerp(b1, b2, t)})`
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

// Accepts both '#rrggbb' and 'rgb(r,g,b)' so tints can be chained (each tint
// returns an 'rgb(...)' string that the next tint must be able to re-parse).
function parseColor(c: string): [number, number, number] {
  if (c[0] === '#') {
    const n = parseInt(c.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = c.match(/-?\d+/g)!
  return [Number(m[0]), Number(m[1]), Number(m[2])]
}
