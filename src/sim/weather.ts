import type { Season } from "../game/state";
import { mulberry32, type RNG } from "./rng";

// Season order for advancement and indexing. Kept here (the weather authority) so
// the deterministic per-season seed never drifts from how seasons cycle.
export const SEASON_ORDER: Season[] = ["spring", "summer", "fall", "winter"];

export const TICKS_PER_SEASON = 60;

// Per-season environmental constants (CLAUDE.md "Seasons" + "Light calculation").
// rainEvents is the baseline count of rain events in a normal (non-drought) season.
export interface SeasonParams {
  sunAngleDeg: number; // ray angle from vertical
  intensity: number; // light multiplier feeding photosynthesis
  rainEvents: number; // baseline rain events per season
  evaporation: number; // per-tick evaporation from the top soil rows
}

export const SEASON_PARAMS: Record<Season, SeasonParams> = {
  spring: { sunAngleDeg: 20, intensity: 0.7, rainEvents: 2, evaporation: 0.01 },
  summer: { sunAngleDeg: 5, intensity: 1.0, rainEvents: 1, evaporation: 0.05 },
  fall: { sunAngleDeg: 20, intensity: 0.5, rainEvents: 2, evaporation: 0.01 },
  winter: { sunAngleDeg: 40, intensity: 0.1, rainEvents: 1, evaporation: 0.01 },
};

// Calendar months shown as a HUD subtitle under the season name.
export const SEASON_MONTHS: Record<Season, string> = {
  spring: "Mar–May",
  summer: "Jun–Aug",
  fall: "Sep–Nov",
  winter: "Dec–Feb",
};

// Storm severity → the stress threshold above which cells snap (CLAUDE.md). A lower
// threshold means weaker cells break, so severe storms fell far more of the tree.
export type StormSeverity = "minor" | "moderate" | "severe";
export const STORM_THRESHOLD: Record<StormSeverity, number> = {
  minor: 1.2,
  moderate: 0.9,
  severe: 0.6,
};

// A storm is a 1–2 tick event whose ticks run a structural-failure check. Deterministic
// from (season, year, worldSeed) like everything else, so the forecast never lies.
export interface Storm {
  startTick: number;
  ticks: number; // 1 or 2
  severity: StormSeverity;
}

// Per-season storm probability (CLAUDE.md "Storm chance": medium spring/fall, low
// summer/winter). Storms are disabled before Year 2 (difficulty curve).
const STORM_CHANCE: Record<Season, number> = {
  spring: 0.35,
  summer: 0.1,
  fall: 0.35,
  winter: 0.1,
};

// The fully-resolved weather for a single season. Deterministic from
// (season, year, worldSeed) so the forecast for an upcoming season is identical to
// what will actually be simulated when the player reaches it.
export interface SeasonWeather {
  season: Season;
  year: number;
  sunAngleDeg: number;
  intensity: number;
  rain: boolean[]; // length TICKS_PER_SEASON; true on ticks where rain falls
  isDrought: boolean;
  storm: Storm | null; // null when no storm this season
}

// A stable per-season RNG: the run's worldSeed mixed with the year and season index.
// Independent of the main simulation RNG, so generating a forecast never perturbs
// the simulation's stochastic order (and vice-versa).
function weatherRng(worldSeed: number, year: number, season: Season): RNG {
  let h = worldSeed >>> 0;
  h = Math.imul(h ^ Math.imul(year, 0x9e3779b9), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (SEASON_ORDER.indexOf(season) + 1), 0xc2b2ae35) >>> 0;
  return mulberry32(h);
}

export function generateWeather(
  season: Season,
  year: number,
  worldSeed: number,
): SeasonWeather {
  const p = SEASON_PARAMS[season];
  const rng = weatherRng(worldSeed, year, season);

  // Droughts arrive in Year 4 (difficulty curve) and never in winter. Always
  // foreseeable a season ahead because the forecast calls this same function.
  const isDrought = year >= 4 && season !== "winter" && rng() < 0.18;

  const rain = new Array<boolean>(TICKS_PER_SEASON).fill(false);
  if (!isDrought) {
    // Vary the event count ±1 around the baseline, but guarantee Year 1 a gentle,
    // well-watered start (CLAUDE.md: Year 1 is gentle, good rain).
    let events = p.rainEvents;
    if (year === 1) {
      events = Math.max(events, season === "summer" ? 1 : 2);
    } else {
      const roll = rng();
      events += roll < 0.4 ? -1 : roll < 0.6 ? 1 : 0;
    }
    events = Math.max(0, events);

    for (let e = 0; e < events; e++) {
      const duration = 8 + Math.floor(rng() * 8); // 8–15 ticks
      const start = Math.floor(rng() * (TICKS_PER_SEASON - duration));
      for (let t = start; t < start + duration; t++) rain[t] = true;
    }
  }

  // Storms roll LAST so adding them never perturbs the drought/rain draws above —
  // existing forecasts stay byte-identical. Enabled from Year 2; severity scales with
  // the difficulty curve (severe storms only from Year 9). Placed away from tick 0
  // (which winter reserves for the frost reset) and from the season's tail.
  let storm: Storm | null = null;
  if (year >= 2 && rng() < STORM_CHANCE[season]) {
    const sevRoll = rng();
    let severity: StormSeverity;
    if (year >= 9)
      severity =
        sevRoll < 0.4 ? "moderate" : sevRoll < 0.75 ? "minor" : "severe";
    else if (year >= 4) severity = sevRoll < 0.5 ? "minor" : "moderate";
    else severity = sevRoll < 0.75 ? "minor" : "moderate";
    const ticks = rng() < 0.5 ? 2 : 1;
    const startTick = 6 + Math.floor(rng() * (TICKS_PER_SEASON - 12));
    storm = { startTick, ticks, severity };
  }

  return {
    season,
    year,
    sunAngleDeg: p.sunAngleDeg,
    intensity: p.intensity,
    rain,
    isDrought,
    storm,
  };
}

export function rainTickCount(w: SeasonWeather): number {
  let n = 0;
  for (const r of w.rain) if (r) n++;
  return n;
}

// The season+year immediately following the given one.
export function nextSeasonYear(
  season: Season,
  year: number,
): { season: Season; year: number } {
  const idx = SEASON_ORDER.indexOf(season);
  const nextIdx = (idx + 1) % 4;
  return {
    season: SEASON_ORDER[nextIdx],
    year: nextIdx === 0 ? year + 1 : year,
  };
}

// ─── forecast headlines ────────────────────────────────────────────────────────

export interface WeatherHeadline {
  icon: string;
  label: string;
}

// A short icon + label for a season's conditions — used both for the exact
// "this season" readout and the greyed "next season" forecast.
export function weatherHeadline(w: SeasonWeather): WeatherHeadline {
  // A severe storm always headlines (CLAUDE.md: severe storms must show in the
  // forecast); otherwise a drought's water story leads, with milder storms after.
  if (w.storm?.severity === "severe")
    return { icon: "⛈️", label: "Severe storm" };
  if (w.isDrought) return { icon: "🌵", label: "Drought" };
  if (w.storm) return { icon: "⛈️", label: "Storms likely" };
  if (w.season === "winter") return { icon: "❄️", label: "Frost" };
  const ticks = rainTickCount(w);
  if (ticks >= 18) return { icon: "🌧️", label: "Wet" };
  if (ticks >= 8) return { icon: "🌦️", label: "Showers" };
  if (ticks === 0) return { icon: "☀️", label: "Dry" };
  return { icon: "⛅", label: "Mild" };
}

// Coarse two-seasons-out trend (CLAUDE.md: "vague trend").
const SEASON_TREND: Record<Season, string> = {
  spring: "warming",
  summer: "hot & dry",
  fall: "cooling",
  winter: "cold ahead",
};

// What each season MEANS for the tree — a one-line "why it matters" shown next to the
// upcoming-season label so the player can plan for it (playtest: "be more explicit about
// what the next season is"). Distinct from the weather forecast (rain/storms): this is
// the seasonal rhythm itself.
const SEASON_MEANING: Record<Season, string> = {
  spring: "grow & flower",
  summer: "peak sun, water stress",
  fall: "harvest, then leaves drop",
  winter: "dormant — live on reserves",
};

export function seasonMeaning(season: Season): string {
  return SEASON_MEANING[season];
}

export function seasonTrend(season: Season): string {
  return SEASON_TREND[season];
}
