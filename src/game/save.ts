import type { Cell } from '../sim/cells'
import { TerrainGen } from '../sim/terrain'
import { hexKey } from '../sim/grid'
import type { GameState, GoalProgress } from './state'

const SAVE_KEY = 'treegame.save.v1'

// Serialized form. Terrain is omitted on purpose: it is a pure deterministic function
// of (q, r), and any soil cells the simulation modified are promoted into `cells`, so
// a fresh TerrainGen() reproduces the world exactly. Weather is likewise omitted — it
// is a pure function of (worldSeed, year, season), so persisting those is enough for
// the future to replay identically.
export interface SaveData {
  v: 1
  cells: Cell[]
  season: GameState['season']
  seasonHalf?: 0 | 1   // optional: pre-checkpoint saves resume at the season start (0)
  year: number
  score: number
  rngSeed: number
  worldSeed: number
  goals: GoalProgress
}

export function serialize(game: GameState): SaveData {
  return {
    v: 1,
    cells: [...game.cells.values()],
    season: game.season,
    seasonHalf: game.seasonHalf,
    year: game.year,
    score: game.score,
    rngSeed: game.rngSeed,
    worldSeed: game.worldSeed,
    goals: game.goals,
  }
}

export function deserialize(data: SaveData): GameState {
  const cells = new Map<string, Cell>()
  for (const c of data.cells) cells.set(hexKey(c.q, c.r), c)
  return {
    cells,
    terrain: new TerrainGen(),
    season: data.season,
    seasonHalf: data.seasonHalf === 1 ? 1 : 0,
    year: data.year,
    score: data.score,
    rngSeed: data.rngSeed,
    worldSeed: data.worldSeed,
    goals: data.goals,
  }
}

// ─── localStorage wrappers (all guard against unavailable/throwing storage) ──────

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function saveGame(game: GameState): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(SAVE_KEY, JSON.stringify(serialize(game)))
  } catch {
    // Quota or serialization failure — a lost autosave is non-fatal.
  }
}

export function loadGame(): GameState | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(SAVE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SaveData
    if (data.v !== 1 || !Array.isArray(data.cells)) return null
    return deserialize(data)
  } catch {
    return null
  }
}

export function clearSave(): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(SAVE_KEY)
  } catch {
    /* ignore */
  }
}
