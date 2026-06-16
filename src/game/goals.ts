import type { Cell } from '../sim/cells'
import { surfaceR } from '../sim/terrain'
import type { Season, GoalProgress } from './state'

// Everything a milestone check can look at. Built once per season advance from the
// post-simulation state plus a little context about what just happened.
export interface GoalContext {
  cells: Map<string, Cell>
  livingCells: number
  peakCells: number
  seasonSimulated: Season
  yearSimulated: number
  shedThisTurn: boolean    // did the player shed ≥1 leaf in the just-resolved plan
  score: number
  droughtThisSeason: boolean   // the just-simulated season was a drought
  stormThisSeason: boolean     // a storm struck the just-simulated season
  stormCellsLost: number       // cells the season's storm(s) snapped (0 = held firm)
  seedsThisSeason: number      // seeds harvested in the just-simulated season (fall only)
  grewFlowerThisTurn: boolean  // the committed plan included ≥1 flower (it's since set/dropped)
}

export interface Milestone {
  id: string
  goal: string   // short imperative shown as the current objective
  log: string    // evocative past-tense entry for the completed-goals log
  check: (ctx: GoalContext) => boolean
}

function has(cells: Map<string, Cell>, type: Cell['type']): boolean {
  for (const c of cells.values()) if (c.type === type) return true
  return false
}

// Ordered list. Revealed one at a time: the HUD shows the lowest-index milestone not
// yet completed. Never run out — append freely. The flower/fruit goals can't complete
// until M10 adds blooms, which is fine; they simply sit as the current goal.
export const MILESTONES: Milestone[] = [
  {
    id: 'first-leaf',
    goal: 'Grow your first leaf',
    log: 'Your first leaf unfurled.',
    check: (c) => has(c.cells, 'leaf'),
  },
  {
    id: 'survive-season',
    goal: 'Survive your first season',
    log: 'Your seedling weathered its first season.',
    check: (c) => c.livingCells > 0,
  },
  {
    id: 'ten-cells',
    goal: 'Grow to 10 cells',
    log: 'Ten cells strong.',
    check: (c) => c.peakCells >= 10,
  },
  {
    id: 'shed-leaves',
    goal: 'Let your canopy fall before winter',
    log: 'Your canopy fell, its energy drawn back into the wood for winter.',
    // The whole canopy now drops automatically each fall (resorbing its energy) — this
    // completes the first time the player simulates a fall season.
    check: (c) => c.seasonSimulated === 'fall',
  },
  {
    id: 'survive-winter',
    goal: 'Survive your first winter',
    log: 'Your tree survived its first winter.',
    check: (c) => c.seasonSimulated === 'winter' && c.livingCells > 0,
  },
  {
    id: 'thirty-cells',
    goal: 'Reach 30 cells',
    log: 'Thirty cells — a real tree now.',
    check: (c) => c.peakCells >= 30,
  },
  {
    id: 'deep-root',
    goal: 'Sink a root to the deep water table (depth ≥ 18)',
    log: 'Your roots tapped the deep water table.',
    check: (c) => {
      for (const cell of c.cells.values()) {
        if (cell.type === 'tree' && cell.r - surfaceR(cell.q) >= 18) return true
      }
      return false
    },
  },
  {
    id: 'first-flower',
    goal: 'Grow your first flower',
    log: 'Your first bloom opened.',
    // Flowers set to fruit (or drop) by spring's end, so the post-sim state rarely still
    // holds a flower — credit the bloom from the committed plan, or any fruit/seed it led to.
    check: (c) => c.grewFlowerThisTurn || has(c.cells, 'flower') || has(c.cells, 'fruit') || c.score > 0,
  },
  {
    id: 'first-fruit',
    goal: 'Mature your first fruit — your first seed!',
    log: 'Your first seed! Life makes more life.',
    check: (c) => c.score > 0 || has(c.cells, 'fruit'),
  },
  {
    id: 'survive-drought',
    goal: 'Survive a drought',
    log: 'You weathered a season of drought.',
    check: (c) => c.droughtThisSeason && c.livingCells > 0,
  },
  {
    id: 'survive-storm',
    goal: 'Weather a storm without losing a single cell',
    log: 'A storm raged — and not a single cell fell.',
    check: (c) => c.stormThisSeason && c.stormCellsLost === 0 && c.livingCells > 0,
  },
  {
    id: 'five-seeds',
    goal: 'Produce 5 seeds in one year',
    log: 'Five seeds in a single year — a bountiful harvest.',
    check: (c) => c.seedsThisSeason >= 5,
  },
  {
    id: 'hundred-cells',
    goal: 'Grow to 100 cells',
    log: 'A hundred cells — a towering tree.',
    check: (c) => c.peakCells >= 100,
  },
  {
    id: 'fruit-drought',
    goal: 'Carry a fruit through a drought summer',
    log: 'You carried fruit through a parched summer.',
    check: (c) => c.droughtThisSeason && c.seasonSimulated === 'summer' && has(c.cells, 'fruit'),
  },
  {
    id: 'lifetime-25',
    goal: 'Produce 25 lifetime seeds',
    log: 'Twenty-five seeds — a legacy of forests.',
    check: (c) => c.score >= 25,
  },
]

const MILESTONE_BY_ID = new Map(MILESTONES.map((m) => [m.id, m]))

// The current objective = the first milestone not yet completed.
export function currentGoal(progress: GoalProgress): Milestone | null {
  for (const m of MILESTONES) {
    if (!progress.completed.includes(m.id)) return m
  }
  return null
}

// Completed milestones, in the order they were achieved, as full Milestone objects.
export function completedMilestones(progress: GoalProgress): Milestone[] {
  const out: Milestone[] = []
  for (const id of progress.completed) {
    const m = MILESTONE_BY_ID.get(id)
    if (m) out.push(m)
  }
  return out
}

// Evaluate all not-yet-completed milestones against the context. Returns updated
// progress and the milestones newly completed this turn (for the season summary/log).
// Pure: does not mutate the input progress.
export function evaluateGoals(
  progress: GoalProgress,
  ctx: GoalContext,
): { progress: GoalProgress; newlyCompleted: Milestone[] } {
  const completed = [...progress.completed]
  const done = new Set(completed)
  const newlyCompleted: Milestone[] = []

  for (const m of MILESTONES) {
    if (done.has(m.id)) continue
    if (m.check(ctx)) {
      completed.push(m.id)
      done.add(m.id)
      newlyCompleted.push(m)
    }
  }

  const peakCells = Math.max(progress.peakCells, ctx.livingCells)
  return { progress: { completed, peakCells }, newlyCompleted }
}
