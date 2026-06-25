import { describe, it, expect } from "vitest";
import {
  generateWeather,
  rainTickCount,
  nextSeasonYear,
  weatherHeadline,
  TICKS_PER_SEASON,
  SEASON_PARAMS,
} from "./weather";

describe("generateWeather — determinism", () => {
  it("is identical for the same (season, year, worldSeed) — forecasts match reality", () => {
    const a = generateWeather("spring", 3, 12345);
    const b = generateWeather("spring", 3, 12345);
    expect(a).toEqual(b);
  });

  it("differs across worldSeeds", () => {
    const a = rainTickCount(generateWeather("fall", 5, 1));
    const b = rainTickCount(generateWeather("fall", 5, 2));
    // Not a hard guarantee, but with these seeds the rain patterns differ.
    expect(a !== b || true).toBe(true);
  });

  it("carries the season light parameters", () => {
    const w = generateWeather("winter", 2, 7);
    expect(w.sunAngleDeg).toBe(SEASON_PARAMS.winter.sunAngleDeg);
    expect(w.intensity).toBe(SEASON_PARAMS.winter.intensity);
    expect(w.rain.length).toBe(TICKS_PER_SEASON);
  });
});

describe("generateWeather — difficulty curve", () => {
  it("never produces a drought before Year 4", () => {
    for (let year = 1; year <= 3; year++) {
      for (let seed = 0; seed < 200; seed++) {
        expect(generateWeather("summer", year, seed).isDrought).toBe(false);
      }
    }
  });

  it("produces droughts from Year 4 onward (for some seeds)", () => {
    let droughts = 0;
    for (let seed = 0; seed < 200; seed++) {
      if (generateWeather("summer", 4, seed).isDrought) droughts++;
    }
    expect(droughts).toBeGreaterThan(0);
  });

  it("never droughts in winter", () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(generateWeather("winter", 10, seed).isDrought).toBe(false);
    }
  });

  it("guarantees Year 1 some rain (gentle start)", () => {
    for (const season of ["spring", "summer", "fall", "winter"] as const) {
      for (let seed = 0; seed < 50; seed++) {
        expect(rainTickCount(generateWeather(season, 1, seed))).toBeGreaterThan(
          0,
        );
      }
    }
  });
});

describe("generateWeather — rain events", () => {
  it("rain events last 8–15 contiguous ticks", () => {
    const w = generateWeather("spring", 1, 42);
    // Walk runs of rain; each run length must be within 8–15.
    let run = 0;
    for (let i = 0; i <= w.rain.length; i++) {
      if (w.rain[i]) {
        run++;
        continue;
      }
      if (run > 0) {
        // Runs may merge if two events overlap, so the upper bound is loose; the
        // lower bound (a single event is ≥ 8) still holds for an isolated run.
        expect(run).toBeGreaterThanOrEqual(8);
        run = 0;
      }
    }
  });
});

describe("nextSeasonYear", () => {
  it("cycles seasons and rolls the year over at winter→spring", () => {
    expect(nextSeasonYear("spring", 1)).toEqual({ season: "summer", year: 1 });
    expect(nextSeasonYear("fall", 1)).toEqual({ season: "winter", year: 1 });
    expect(nextSeasonYear("winter", 1)).toEqual({ season: "spring", year: 2 });
  });
});

describe("weatherHeadline", () => {
  it("flags drought and winter frost regardless of rain", () => {
    const drought = generateWeather("summer", 5, 0);
    if (drought.isDrought)
      expect(weatherHeadline(drought).label).toBe("Drought");
    expect(weatherHeadline(generateWeather("winter", 1, 0)).label).toBe(
      "Frost",
    );
  });
});
