// Headless harness for the tree game — drives the REAL sim/planning/goal logic with no
// canvas or React, so playthroughs are fast, deterministic, and inspectable. Used to
// playtest balance and reproduce UX issues from the terminal.

import { createInitialState, type GameState } from '../game/state'
import {
  createPlanningState, handleTap, applySeasonAdvance, resolvableShedKeys,
  bankedEnergy, getValidPlacements, canPlaceFlower, SPRING_VIGOR,
  type PlanningState, type PlacementMode,
} from '../game/planning'
import { generateWeather, weatherHeadline, type SeasonWeather } from '../sim/weather'
import { runSeason, mulberry32 } from '../sim/simulate'
import { computeStructure } from '../sim/structure'
import { evaluateGoals, currentGoal, type GoalContext } from '../game/goals'
import { buildSeasonSummary } from '../game/summary'
import { surfaceR } from '../sim/terrain'
import { hexKey, hexPixelX } from '../sim/grid'
import type { Cell } from '../sim/cells'

export interface AdvanceReport {
  season: GameState['season']
  year: number
  weather: string
  bankedBefore: number
  bankedAfter: number
  cellsBefore: number
  cellsAfter: number
  seedsHarvested: number
  cellsLostToStorm: number
  newlyCompleted: string[]
  summaryEvents: string[]
}

export class Headless {
  game: GameState
  planning: PlanningState

  constructor(worldSeed = 1234, rngSeed = 5678) {
    const g = createInitialState()
    this.game = { ...g, worldSeed, rngSeed }
    this.planning = createPlanningState(bankedEnergy(this.game.cells))
  }

  // ── accessors ──────────────────────────────────────────────────────────────
  get season() { return this.game.season }
  get year() { return this.game.year }
  get score() { return this.game.score }
  get budget() { return this.planning.energyAvailable }
  get spent() { return this.planning.energySpent }
  get remaining() { return this.planning.energyAvailable - this.planning.energySpent }
  get banked() { return bankedEnergy(this.game.cells) }
  get weather(): SeasonWeather { return generateWeather(this.game.season, this.game.year, this.game.worldSeed) }

  livingCount(): number {
    let n = 0
    for (const c of this.game.cells.values())
      if (c.type === 'tree' || c.type === 'leaf' || c.type === 'flower' || c.type === 'fruit') n++
    return n
  }

  validPlacements(mode: PlacementMode) { return getValidPlacements(mode, this.game, this.planning) }

  // ── actions ────────────────────────────────────────────────────────────────
  place(q: number, r: number, mode: PlacementMode): boolean {
    const res = handleTap(q, r, mode, this.game, this.planning)
    if (res.kind === 'placed') { this.planning = res.planning!; return true }
    return false
  }

  // Stage every currently-valid placement for a mode, up to a budget fraction.
  fill(mode: PlacementMode, maxCells = Infinity, budgetFraction = 1): number {
    let placed = 0
    while (placed < maxCells) {
      const valid = this.validPlacements(mode)
      let did = false
      for (const key of valid.keys()) {
        if (this.remaining < (mode === 'flower' ? 3 : 1)) break
        if (this.spent >= this.budget * budgetFraction) break
        const [q, r] = key.split(',').map(Number)
        if (this.place(q, r, mode)) { placed++; did = true; if (placed >= maxCells) break }
      }
      if (!did) break
    }
    return placed
  }

  shedAllLeaves(): number {
    let n = 0
    for (const [key, c] of this.game.cells) {
      if (c.type !== 'leaf') continue
      const res = handleTap(c.q, c.r, 'leaf', this.game, this.planning)
      if (res.kind === 'shed_toggled') { this.planning = res.planning!; n++; void key }
    }
    return n
  }

  prune(q: number, r: number): boolean {
    const key = hexKey(q, r)
    if (!this.game.cells.has(key)) return false
    // Mirror App.onPrune minimally: remove cell + anything it disconnects is handled by
    // the sim's connectivity at advance; here we just delete the single cell for tests.
    const cells = new Map(this.game.cells)
    cells.delete(key)
    this.game = { ...this.game, cells }
    return true
  }

  // ── advance (mirrors App.onAdvanceSeason + finishPlayback) ───────────────────
  advance(): AdvanceReport {
    const cur = this.game
    const weather = generateWeather(cur.season, cur.year, cur.worldSeed)
    const shedKeys = resolvableShedKeys(cur, this.planning)
    const shedThisTurn = shedKeys.size > 0

    const bankedBefore = bankedEnergy(cur.cells)
    const cellsBefore = this.livingCount()

    const committed = applySeasonAdvance(cur, this.planning)
    const rng = mulberry32(committed.rngSeed)
    const { frames, storms } = runSeason(committed, rng, weather, shedKeys)
    const final = frames[frames.length - 1]

    const nextSeed = Math.floor(mulberry32(final.rngSeed)() * 0xffffffff)

    const livingCells = countLiving(final.cells)
    const stormCellsLost = storms.reduce((a, s) => a + s.cellsLost, 0)
    const ctx: GoalContext = {
      cells: final.cells,
      livingCells,
      peakCells: Math.max(final.goals.peakCells, livingCells),
      seasonSimulated: weather.season,
      yearSimulated: weather.year,
      shedThisTurn,
      score: final.score,
      droughtThisSeason: weather.isDrought,
      stormThisSeason: weather.storm != null,
      stormCellsLost,
      seedsThisSeason: Math.max(0, final.score - committed.score),
      grewFlowerThisTurn: [...committed.cells.values()].some((c) => c.type === 'flower'),
    }
    const { progress, newlyCompleted } = evaluateGoals(final.goals, ctx)

    this.game = { ...final, rngSeed: nextSeed, goals: progress }
    const budget = this.game.season === 'spring'
      ? Math.max(bankedEnergy(this.game.cells), SPRING_VIGOR)
      : bankedEnergy(this.game.cells)
    this.planning = createPlanningState(budget)

    const summary = buildSeasonSummary(committed, final, weather)

    return {
      season: weather.season,
      year: weather.year,
      weather: weatherHeadline(weather).label + (weather.isDrought ? ' (drought)' : ''),
      bankedBefore,
      bankedAfter: bankedEnergy(this.game.cells),
      cellsBefore,
      cellsAfter: countLiving(this.game.cells),
      seedsHarvested: Math.max(0, final.score - committed.score),
      cellsLostToStorm: stormCellsLost,
      newlyCompleted: newlyCompleted.map((m) => m.id),
      summaryEvents: summary.events,
    }
  }

  goal(): string | null { return currentGoal(this.game.goals)?.goal ?? null }

  // ── diagnostics ──────────────────────────────────────────────────────────────
  // Aggregate health/water/energy by vertical band, to spot mid-trunk starvation etc.
  bands() {
    const above: Cell[] = [], roots: Cell[] = []
    for (const c of this.game.cells.values()) {
      if (c.type === 'soil' || c.type === 'rock' || c.type === 'deadwood') continue
      if (c.r >= surfaceR(c.q)) roots.push(c); else above.push(c)
    }
    above.sort((a, b) => a.r - b.r) // top first
    const third = Math.ceil(above.length / 3) || 1
    const top = above.slice(0, third)
    const mid = above.slice(third, 2 * third)
    const low = above.slice(2 * third)
    const agg = (cs: Cell[]) => cs.length === 0 ? null : {
      n: cs.length,
      water: +(cs.reduce((a, c) => a + c.water, 0) / cs.length).toFixed(1),
      energy: +(cs.reduce((a, c) => a + c.energy, 0) / cs.length).toFixed(1),
      health: +(cs.reduce((a, c) => a + c.health, 0) / cs.length).toFixed(2),
      minHealth: +Math.min(...cs.map((c) => c.health)).toFixed(2),
    }
    return { top: agg(top), mid: agg(mid), low: agg(low), roots: agg(roots) }
  }

  // Why can/can't flowers be placed right now? Returns the count of valid spots and a
  // breakdown of how many wood tips exist vs. how many are healthy enough.
  flowerDiagnosis() {
    const valid = this.validPlacements('flower').size
    let aboveGroundWood = 0, tips = 0, healthyTips = 0
    for (const c of this.game.cells.values()) {
      if (c.type !== 'tree') continue
      if (c.r >= surfaceR(c.q)) continue
      aboveGroundWood++
      const hasUp = this.game.cells.get(hexKey(c.q, c.r - 1))?.type === 'tree'
        || this.game.cells.get(hexKey(c.q + 1, c.r - 1))?.type === 'tree'
      if (!hasUp) { tips++; if (c.health > 0.6) healthyTips++ }
    }
    return { valid, aboveGroundWood, tips, healthyTips, season: this.game.season }
  }

  stressMax(): number {
    const { stress } = computeStructure(this.game.cells)
    let m = 0
    for (const v of stress.values()) if (v > m) m = v
    return +m.toFixed(2)
  }

  // ── ascii render ───────────────────────────────────────────────────────────
  render(opts: { soil?: boolean; pad?: number } = {}): string {
    const pad = opts.pad ?? 2
    const cells = [...this.game.cells.values()].filter((c) => c.type !== 'rock' && (opts.soil || c.type !== 'soil'))
    if (cells.length === 0) return '(empty)'
    let minR = Infinity, maxR = -Infinity, minX = Infinity, maxX = -Infinity
    for (const c of cells) {
      const x = hexPixelX(c.q, c.r)
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r
      if (x < minX) minX = x; if (x > maxX) maxX = x
    }
    minR -= pad; maxR += pad; minX -= pad; maxX += pad
    const W = Math.round((maxX - minX) * 2) + 1
    const H = maxR - minR + 1
    const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(' '))
    for (const c of this.game.cells.values()) {
      if (c.type === 'rock') continue
      if (!opts.soil && c.type === 'soil') continue
      const x = hexPixelX(c.q, c.r)
      const col = Math.round((x - minX) * 2)
      const row = c.r - minR
      if (row < 0 || row >= H || col < 0 || col >= W) continue
      grid[row][col] = glyph(c)
    }
    return grid.map((r) => r.join('')).join('\n')
  }
}

function countLiving(cells: Map<string, Cell>): number {
  let n = 0
  for (const c of cells.values())
    if (c.type === 'tree' || c.type === 'leaf' || c.type === 'flower' || c.type === 'fruit') n++
  return n
}

// Single-char glyph encoding type + state. Upper = healthy, lower = ailing.
function glyph(c: Cell): string {
  const ailing = c.health < 0.5
  switch (c.type) {
    case 'tree': {
      const root = c.r >= surfaceR(c.q)
      if (root) return ailing ? 'r' : 'R'
      return ailing ? 't' : 'T'
    }
    case 'leaf': return ailing ? ',' : '*'
    case 'flower': return '@'
    case 'fruit': return (c.maturity ?? 0) >= 1 ? 'O' : 'o'
    case 'deadwood': return 'x'
    case 'soil': return c.water > 10 ? ':' : '.'
    case 'rock': return '%'
  }
}
