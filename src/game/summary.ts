import type { Cell } from '../sim/cells'
import type { GameState, Season } from './state'
import type { SeasonWeather } from '../sim/weather'
import { rainTickCount } from '../sim/weather'
import { bankedEnergy } from './planning'

// Everything the post-playback season summary needs, computed by comparing the
// committed (pre-simulation) state to the final (post-simulation) state.
export interface SeasonSummaryData {
  season: Season
  year: number
  energyStart: number
  energyEnd: number
  cellsStart: number
  cellsEnd: number
  cellsGained: number
  cellsLost: number
  leavesDropped: number
  deadwoodCreated: number
  waterStatus: string
  events: string[]
}

const LIVING: ReadonlySet<Cell['type']> = new Set<Cell['type']>(['tree', 'leaf', 'flower', 'fruit'])

function count(cells: Map<string, Cell>, pred: (c: Cell) => boolean): number {
  let n = 0
  for (const c of cells.values()) if (pred(c)) n++
  return n
}

function averageTreeWater(cells: Map<string, Cell>): number {
  let sum = 0, n = 0
  for (const c of cells.values()) {
    if (c.type === 'tree' || c.type === 'leaf') { sum += c.water; n++ }
  }
  return n === 0 ? 0 : sum / n
}

function waterLabel(avg: number): string {
  if (avg >= 6) return 'Well watered'
  if (avg >= 3) return 'Adequately watered'
  if (avg >= 1) return 'Running dry'
  return 'Parched'
}

export function buildSeasonSummary(
  committed: GameState,
  final: GameState,
  weather: SeasonWeather,
): SeasonSummaryData {
  const energyStart = bankedEnergy(committed.cells)
  const energyEnd = bankedEnergy(final.cells)

  const cellsStart = count(committed.cells, (c) => LIVING.has(c.type))
  const cellsEnd = count(final.cells, (c) => LIVING.has(c.type))

  const leavesStart = count(committed.cells, (c) => c.type === 'leaf')
  const leavesEnd = count(final.cells, (c) => c.type === 'leaf')
  const leavesDropped = Math.max(0, leavesStart - leavesEnd)

  const deadStart = count(committed.cells, (c) => c.type === 'deadwood')
  const deadEnd = count(final.cells, (c) => c.type === 'deadwood')
  const deadwoodCreated = Math.max(0, deadEnd - deadStart)

  // A cell count can both rise (new growth survives) and fall (deaths). We report
  // the net gain and the explicit losses (deaths + drops) separately.
  const cellsGained = Math.max(0, cellsEnd - cellsStart)
  const cellsLost = Math.max(0, cellsStart - cellsEnd)

  const events: string[] = []
  if (weather.isDrought) events.push('A drought gripped the land — soil ran dry.')
  const rainTicks = rainTickCount(weather)
  if (rainTicks > 0 && !weather.isDrought) {
    events.push(rainTicks >= 18 ? 'Heavy rains soaked the soil.' : 'Rains watered the ground.')
  } else if (rainTicks === 0 && !weather.isDrought) {
    events.push('A dry season — no rain fell.')
  }
  if (weather.season === 'winter') {
    events.push(
      leavesDropped > 0
        ? `Winter frost — ${leavesDropped} ${leavesDropped === 1 ? 'leaf' : 'leaves'} dropped.`
        : 'Winter frost settled in.',
    )
  }
  if (deadwoodCreated > 0) {
    events.push(`${deadwoodCreated} ${deadwoodCreated === 1 ? 'cell' : 'cells'} died back to deadwood.`)
  }

  return {
    season: weather.season,
    year: weather.year,
    energyStart,
    energyEnd,
    cellsStart,
    cellsEnd,
    cellsGained,
    cellsLost,
    leavesDropped,
    deadwoodCreated,
    waterStatus: waterLabel(averageTreeWater(final.cells)),
    events,
  }
}
