import { describe, it, expect } from 'vitest'
import { serialize, deserialize } from './save'
import { hexKey } from '../sim/grid'
import { TerrainGen } from '../sim/terrain'
import type { GameState } from './state'
import type { Cell } from '../sim/cells'

function sample(): GameState {
  const cells = new Map<string, Cell>()
  cells.set(hexKey(0, 0), { q: 0, r: 0, type: 'tree', water: 5, energy: 8, health: 1, rot: 0, age: 2 })
  cells.set(hexKey(0, -1), { q: 0, r: -1, type: 'leaf', water: 3, energy: 4, health: 0.9, rot: 0, age: 1 })
  cells.set(hexKey(0, 1), { q: 0, r: 1, type: 'soil', water: 12, energy: 0, health: 1, rot: 0, age: 0 })
  return {
    cells, terrain: new TerrainGen(), season: 'fall', year: 3, score: 4,
    rngSeed: 111, worldSeed: 222, goals: { completed: ['first-leaf', 'survive-season'], peakCells: 14 },
  }
}

describe('save round-trip', () => {
  it('serialize → deserialize preserves all gameplay state', () => {
    const game = sample()
    const restored = deserialize(serialize(game))

    expect(restored.season).toBe('fall')
    expect(restored.year).toBe(3)
    expect(restored.score).toBe(4)
    expect(restored.rngSeed).toBe(111)
    expect(restored.worldSeed).toBe(222)
    expect(restored.goals).toEqual({ completed: ['first-leaf', 'survive-season'], peakCells: 14 })

    expect(restored.cells.size).toBe(3)
    expect(restored.cells.get(hexKey(0, 0))).toEqual(game.cells.get(hexKey(0, 0)))
    expect(restored.cells.get(hexKey(0, -1))!.type).toBe('leaf')
    expect(restored.cells.get(hexKey(0, 1))!.water).toBe(12)
  })

  it('survives a JSON encode/decode (no Maps/functions leak into the blob)', () => {
    const blob = JSON.stringify(serialize(sample()))
    const restored = deserialize(JSON.parse(blob))
    expect(restored.cells.size).toBe(3)
    expect(restored.worldSeed).toBe(222)
  })

  it('reconstructs a working terrain generator', () => {
    const restored = deserialize(serialize(sample()))
    // Terrain isn't serialized; a fresh generator must still answer queries.
    expect(restored.terrain.get(0, 5)).not.toBeNull()
  })
})
