import { describe, it, expect } from 'vitest'
import { evaluateGoals, currentGoal, completedMilestones, MILESTONES, type GoalContext } from './goals'
import { hexKey } from '../sim/grid'
import { surfaceR } from '../sim/terrain'
import type { Cell } from '../sim/cells'
import type { GoalProgress, Season } from './state'

function cells(list: Cell[]): Map<string, Cell> {
  const m = new Map<string, Cell>()
  for (const c of list) m.set(hexKey(c.q, c.r), c)
  return m
}

function cell(q: number, r: number, type: Cell['type']): Cell {
  return { q, r, type, water: 5, energy: 5, health: 1, rot: 0, age: 1 }
}

function ctx(over: Partial<GoalContext>): GoalContext {
  return {
    cells: over.cells ?? new Map(),
    livingCells: over.livingCells ?? 0,
    peakCells: over.peakCells ?? 0,
    seasonSimulated: over.seasonSimulated ?? 'spring',
    yearSimulated: over.yearSimulated ?? 1,
    shedThisTurn: over.shedThisTurn ?? false,
    score: over.score ?? 0,
    droughtThisSeason: over.droughtThisSeason ?? false,
    stormThisSeason: over.stormThisSeason ?? false,
    stormCellsLost: over.stormCellsLost ?? 0,
  }
}

const fresh: GoalProgress = { completed: [], peakCells: 1 }

describe('evaluateGoals', () => {
  it('completes the first leaf + survive-season together on a leafy first season', () => {
    const c = cells([cell(0, 0, 'tree'), cell(0, -1, 'leaf')])
    const { progress, newlyCompleted } = evaluateGoals(fresh, ctx({ cells: c, livingCells: 2, peakCells: 2 }))
    const ids = newlyCompleted.map((m) => m.id)
    expect(ids).toContain('first-leaf')
    expect(ids).toContain('survive-season')
    expect(progress.completed).toEqual(['first-leaf', 'survive-season'])
  })

  it('does not re-complete an already-completed milestone', () => {
    const c = cells([cell(0, 0, 'tree'), cell(0, -1, 'leaf')])
    const after = evaluateGoals(fresh, ctx({ cells: c, livingCells: 2 }))
    const again = evaluateGoals(after.progress, ctx({ cells: c, livingCells: 2 }))
    expect(again.newlyCompleted).toEqual([])
  })

  it('uses peak cells, not current, so winter shrinkage does not block size goals', () => {
    // Only 4 cells alive now, but peak was 12 → the 10-cell goal still completes.
    const { newlyCompleted } = evaluateGoals(fresh, ctx({ livingCells: 4, peakCells: 12 }))
    expect(newlyCompleted.map((m) => m.id)).toContain('ten-cells')
  })

  it('tracks the running peak across calls', () => {
    let p = fresh
    p = evaluateGoals(p, ctx({ livingCells: 8 })).progress
    expect(p.peakCells).toBe(8)
    p = evaluateGoals(p, ctx({ livingCells: 3 })).progress
    expect(p.peakCells).toBe(8) // does not drop
  })

  it('shed-leaves only fires when leaves were shed in a fall turn', () => {
    expect(evaluateGoals(fresh, ctx({ seasonSimulated: 'spring' as Season, shedThisTurn: true, livingCells: 1 }))
      .newlyCompleted.map((m) => m.id)).not.toContain('shed-leaves')
    expect(evaluateGoals(fresh, ctx({ seasonSimulated: 'fall' as Season, shedThisTurn: true, livingCells: 1 }))
      .newlyCompleted.map((m) => m.id)).toContain('shed-leaves')
  })

  it('survive-winter requires a winter season', () => {
    expect(evaluateGoals(fresh, ctx({ seasonSimulated: 'winter' as Season, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).toContain('survive-winter')
  })

  it('deep-root fires for a root at depth ≥ 18 below the surface', () => {
    const r = surfaceR(0) + 18
    const c = cells([cell(0, r, 'tree')])
    expect(evaluateGoals(fresh, ctx({ cells: c, livingCells: 1 }))
      .newlyCompleted.map((m) => m.id)).toContain('deep-root')
  })

  it('survive-drought fires only when a drought season is survived', () => {
    expect(evaluateGoals(fresh, ctx({ droughtThisSeason: false, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).not.toContain('survive-drought')
    expect(evaluateGoals(fresh, ctx({ droughtThisSeason: true, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).toContain('survive-drought')
  })

  it('survive-storm fires only on a storm season with zero cells lost', () => {
    // A storm that snapped cells does NOT complete the clean-survival goal.
    expect(evaluateGoals(fresh, ctx({ stormThisSeason: true, stormCellsLost: 4, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).not.toContain('survive-storm')
    // No storm at all → no completion.
    expect(evaluateGoals(fresh, ctx({ stormThisSeason: false, stormCellsLost: 0, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).not.toContain('survive-storm')
    // A storm weathered without a single loss → completes.
    expect(evaluateGoals(fresh, ctx({ stormThisSeason: true, stormCellsLost: 0, livingCells: 3 }))
      .newlyCompleted.map((m) => m.id)).toContain('survive-storm')
  })
})

describe('currentGoal / completedMilestones', () => {
  it('currentGoal returns the first uncompleted milestone', () => {
    expect(currentGoal(fresh)!.id).toBe(MILESTONES[0].id)
    const after = { completed: ['first-leaf'], peakCells: 2 }
    expect(currentGoal(after)!.id).toBe('survive-season')
  })

  it('completedMilestones returns them in completion order', () => {
    const p = { completed: ['survive-season', 'first-leaf'], peakCells: 2 }
    expect(completedMilestones(p).map((m) => m.id)).toEqual(['survive-season', 'first-leaf'])
  })
})
