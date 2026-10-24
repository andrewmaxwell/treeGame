import { describe, it, expect } from "vitest";
import { buildSeasonSummary } from "./summary";
import { createInitialState } from "./state";
import { generateWeather } from "../sim/weather";
import { hexKey } from "../sim/grid";

describe("season summary pacing", () => {
  const start = createInitialState();
  const weather = generateWeather("summer", 1, start.worldSeed);

  it("a quiet first half is not notable and says which half it was", () => {
    const committed = {
      ...start,
      season: "summer" as const,
      seasonHalf: 1 as const,
    };
    const s = buildSeasonSummary(committed, committed, weather);
    expect(s.half).toBe(0);
    expect(s.notable).toBe(false);
  });

  it("a harvest stops the player even mid-season", () => {
    const cells = new Map(start.cells);
    const fruit = {
      q: 5,
      r: -5,
      type: "fruit" as const,
      water: 3,
      energy: 3,
      health: 1,
      rot: 0,
      age: 0,
      maturity: 1,
    };
    cells.set(hexKey(5, -5), fruit);
    const committed = { ...start, cells };
    const final = { ...start, score: 1, seasonHalf: 0 as const };
    const s = buildSeasonSummary(committed, final, weather);
    expect(s.half).toBe(1);
    expect(s.notable).toBe(true);
  });
});
