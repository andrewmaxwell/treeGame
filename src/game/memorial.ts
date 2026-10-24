import { SEASON_ORDER } from "../sim/weather";
import type { GameState, Season } from "./state";

// The memorial: what a tree amounted to when the player replants. Trees can't die (see
// BACKLOG "Memorial screen"), so a run ends when the player chooses "Plant a new seed",
// and the record goes into a small local hall of best runs to beat next time.

export interface RunRecord {
  seeds: number; // lifetime seeds (the score)
  halfSeasons: number; // simulated half-seasons lived
  bestYear: { year: number; seeds: number } | null;
  peakCells: number;
  milestones: number;
  endSeason: Season; // the season it was replanted in
  endYear: number;
  date: string; // YYYY-MM-DD the run ended (local)
}

export const HALL_SIZE = 8;
const HALL_KEY = "treegame.memorials.v1";

export function runRecord(game: GameState, date: Date): RunRecord {
  const seasons = (game.year - 1) * 4 + SEASON_ORDER.indexOf(game.season);
  let bestYear: RunRecord["bestYear"] = null;
  (game.goals.yearSeeds ?? []).forEach((seeds, i) => {
    if (seeds > 0 && (!bestYear || seeds > bestYear.seeds))
      bestYear = { year: i + 1, seeds };
  });
  return {
    seeds: game.score,
    halfSeasons: seasons * 2 + game.seasonHalf,
    bestYear,
    peakCells: game.goals.peakCells,
    milestones: game.goals.completed.length,
    endSeason: game.season,
    endYear: game.year,
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  };
}

// A seed replanted before a single half-season has run has nothing to remember.
export function worthRemembering(game: GameState): boolean {
  return runRecord(game, new Date(0)).halfSeasons > 0;
}

// "4 years, 1 season" — whole seasons lived; a lone half-season reads as such.
export function formatAge(halfSeasons: number): string {
  const seasons = Math.floor(halfSeasons / 2);
  if (seasons === 0) return "half a season";
  const y = Math.floor(seasons / 4);
  const s = seasons % 4;
  const parts: string[] = [];
  if (y > 0) parts.push(`${y} ${y === 1 ? "year" : "years"}`);
  if (s > 0) parts.push(`${s} ${s === 1 ? "season" : "seasons"}`);
  return parts.join(", ");
}

// One plain sentence about the tree's life.
export function eulogy(r: RunRecord): string {
  const when = `${r.endSeason === "fall" ? "the fall" : r.endSeason} of Year ${r.endYear}`;
  const life = `It stood ${formatAge(r.halfSeasons)} and grew to ${r.peakCells} ${r.peakCells === 1 ? "cell" : "cells"}`;
  if (r.seeds === 0)
    return `${life}, but never set seed. Replanted in ${when}.`;
  return `${life}, raising ${r.seeds} ${r.seeds === 1 ? "seed" : "seeds"}. Replanted in ${when}.`;
}

// Best runs first: most seeds, then the longer life. Returns the new hall (capped) and
// the new record's place in it (0-based), or null if it didn't make the cut.
export function addToHall(
  hall: RunRecord[],
  rec: RunRecord,
): { hall: RunRecord[]; rank: number | null } {
  const all = [...hall, rec].sort(
    (a, b) => b.seeds - a.seeds || b.halfSeasons - a.halfSeasons,
  );
  const kept = all.slice(0, HALL_SIZE);
  const rank = kept.indexOf(rec);
  return { hall: kept, rank: rank === -1 ? null : rank };
}

export function loadHall(): RunRecord[] {
  try {
    const raw = localStorage.getItem(HALL_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as RunRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveHall(hall: RunRecord[]): void {
  try {
    localStorage.setItem(HALL_KEY, JSON.stringify(hall));
  } catch {
    // A lost record is non-fatal; the memorial still shows.
  }
}
