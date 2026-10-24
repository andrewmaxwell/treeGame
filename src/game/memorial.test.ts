import { describe, it, expect } from "vitest";
import {
  runRecord,
  worthRemembering,
  formatAge,
  eulogy,
  addToHall,
  HALL_SIZE,
  type RunRecord,
} from "./memorial";
import { evaluateGoals, type GoalContext } from "./goals";
import { createInitialState, type GameState } from "./state";

function game(over: Partial<GameState>): GameState {
  return { ...createInitialState(), ...over };
}

function rec(seeds: number, halfSeasons: number): RunRecord {
  return {
    seeds,
    halfSeasons,
    bestYear: null,
    peakCells: 10,
    milestones: 3,
    endSeason: "spring",
    endYear: 2,
    date: "2026-10-24",
  };
}

describe("runRecord", () => {
  it("counts the seasons lived and finds the best year", () => {
    const g = game({
      year: 5,
      season: "summer",
      seasonHalf: 1,
      score: 17,
      goals: { completed: ["a", "b"], peakCells: 40, yearSeeds: [0, 3, 9, 5] },
    });
    const r = runRecord(g, new Date(2026, 9, 4));
    expect(r.halfSeasons).toBe((4 * 4 + 1) * 2 + 1);
    expect(r.bestYear).toEqual({ year: 3, seeds: 9 });
    expect(r.seeds).toBe(17);
    expect(r.peakCells).toBe(40);
    expect(r.milestones).toBe(2);
    expect(r.date).toBe("2026-10-04");
  });

  it("has no best year before any harvest", () => {
    expect(runRecord(game({ year: 2 }), new Date()).bestYear).toBeNull();
  });

  it("only remembers a tree that lived at least half a season", () => {
    expect(worthRemembering(game({}))).toBe(false);
    expect(worthRemembering(game({ seasonHalf: 1 }))).toBe(true);
  });
});

describe("formatAge / eulogy", () => {
  it("reads in years and seasons", () => {
    expect(formatAge(1)).toBe("half a season");
    expect(formatAge(2)).toBe("1 season");
    expect(formatAge(8)).toBe("1 year");
    expect(formatAge(2 * 17 + 1)).toBe("4 years, 1 season");
  });

  it("mentions seeds only when there were some", () => {
    expect(eulogy({ ...rec(0, 6), peakCells: 1 })).toBe(
      "It stood 3 seasons and grew to 1 cell, but never set seed. Replanted in spring of Year 2.",
    );
    expect(eulogy({ ...rec(1, 8), endSeason: "fall" })).toContain(
      "raising 1 seed. Replanted in the fall of Year 2.",
    );
  });
});

describe("addToHall", () => {
  it("ranks by seeds, then by the longer life, and caps the list", () => {
    let hall: RunRecord[] = [];
    for (let i = 0; i < HALL_SIZE; i++) hall = addToHall(hall, rec(i, 4)).hall;
    const tie = rec(5, 10);
    const res = addToHall(hall, tie);
    expect(res.hall).toHaveLength(HALL_SIZE);
    expect(res.rank).toBe(2); // 7, 6, then the longer-lived 5
    expect(addToHall(res.hall, rec(0, 1)).rank).toBeNull();
  });
});

describe("evaluateGoals tracks seeds per year", () => {
  const base: GoalContext = {
    cells: new Map(),
    livingCells: 5,
    peakCells: 5,
    seasonSimulated: "fall",
    yearSimulated: 3,
    shedThisTurn: false,
    score: 0,
    droughtThisSeason: false,
    stormThisSeason: false,
    stormCellsLost: 0,
    seedsThisSeason: 4,
    grewFlowerThisTurn: false,
  };
  it("adds a harvest to its year and leaves the rest alone", () => {
    const p1 = evaluateGoals({ completed: [], peakCells: 1 }, base).progress;
    expect(p1.yearSeeds).toEqual([0, 0, 4]);
    const p2 = evaluateGoals(p1, { ...base, seedsThisSeason: 0 }).progress;
    expect(p2.yearSeeds).toEqual([0, 0, 4]);
  });
});
