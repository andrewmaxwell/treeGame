import type { Season } from "../game/state";
import { lerpColor } from "./colors";

// The visible world around the tree: a season-coloured sky, a sun placed where the light
// model says it is, and the weather the sim is actually running (rain/snow, storm wind,
// drought haze, a lightning flash). Render-only; every input comes from the season's
// deterministic SeasonWeather, so what you see is what the simulation is doing.

export interface SceneEnv {
  season: Season;
  sunAngleDeg: number; // light-ray angle from vertical (SEASON_PARAMS) — the sun sits up-left
  intensity: number; // season light multiplier, 0.1 (winter) … 1 (summer)
  rain: number; // 0–1 displayed rain (snow in winter), eased toward the tick's rain flag
  wind: number; // 0–1 displayed storm wind
  drought: number; // 0–1 drought haze
  flash: number; // 0–1 lightning flash (decays after a storm starts)
  seasonT: number; // 0–1 progress through the season (autumn leaves colour as it advances)
  now: number; // ms, drives precipitation / cloud motion
}

interface SkyColors {
  top: string;
  horizon: string;
  grass: string; // the season's colour on the top soil row
}

const SKY: Record<Season, SkyColors> = {
  spring: { top: "#24477a", horizon: "#7aa8c8", grass: "#6e9e48" },
  summer: { top: "#1f4f94", horizon: "#9cc8e0", grass: "#8f9c3e" },
  fall: { top: "#2f3a66", horizon: "#c99566", grass: "#b0803a" },
  winter: { top: "#2a3242", horizon: "#8e9aaa", grass: "#dfe7ef" },
};
const STORM_TOP = "#262b35";
const STORM_HORIZON = "#5d6672";
const HAZE_TOP = "#5f7898";
const HAZE_HORIZON = "#e2cf98";
const DROUGHT_GRASS = "#b9a35e";

export function grassColor(env: SceneEnv): string {
  const base = SKY[env.season].grass;
  return env.drought > 0 ? lerpColor(base, DROUGHT_GRASS, env.drought) : base;
}

// Screen-space direction the light travels, as (dx, dy) per unit dy. computeLight shifts a
// ray's column by (rows down)·tanθ to the right, and a column is √3·R wide while a row is
// 1.5·R tall, so on screen the ray leans 2/√3 more than θ — sunlight comes from the upper left.
function lightSlope(sunAngleDeg: number): number {
  return (Math.tan((sunAngleDeg * Math.PI) / 180) * 2) / Math.sqrt(3);
}

// Background sky, sun, sun shafts, and clouds. `horizonY` is the screen y of the nominal
// ground line (may be off-screen). Drawn first; terrain and the tree paint over it.
export function drawSky(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  horizonY: number,
  zoom: number,
  env: SceneEnv,
): void {
  const c = SKY[env.season];
  let top = c.top;
  let horizon = c.horizon;
  if (env.drought > 0) {
    top = lerpColor(top, HAZE_TOP, env.drought * 0.6);
    horizon = lerpColor(horizon, HAZE_HORIZON, env.drought * 0.7);
  }
  const overcast = Math.max(env.rain * 0.85, env.wind);
  if (overcast > 0) {
    top = lerpColor(top, STORM_TOP, overcast);
    horizon = lerpColor(horizon, STORM_HORIZON, overcast);
  }

  // The gradient spans a fixed world height above the ground, so it scrolls with the world.
  const skyH = 700 * zoom;
  const g = ctx.createLinearGradient(0, horizonY - skyH, 0, horizonY);
  g.addColorStop(0, top);
  g.addColorStop(1, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  if (horizonY < 0) return; // looking at the underground only

  // Sun: up-left of screen centre along the true light direction, dimmed by cloud.
  // Kept below the HUD bar (~120px) when the sky allows.
  const slope = lightSlope(env.sunAngleDeg);
  const sunY = Math.max(Math.min(130, horizonY - 60), horizonY - height * 0.6);
  const sunX = width / 2 - slope * (horizonY - sunY);
  const sunR = (10 + 14 * env.intensity) * Math.min(1.4, Math.max(0.7, zoom));
  const vis = (1 - overcast * 0.85) * (0.55 + 0.45 * env.intensity);
  if (vis > 0.02 && sunY > -sunR * 4) {
    const glow = ctx.createRadialGradient(
      sunX,
      sunY,
      sunR * 0.5,
      sunX,
      sunY,
      sunR * 6,
    );
    glow.addColorStop(0, `rgba(255,236,170,${0.45 * vis})`);
    glow.addColorStop(1, "rgba(255,236,170,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - sunR * 6, sunY - sunR * 6, sunR * 12, sunR * 12);
    ctx.fillStyle = `rgba(255,244,205,${vis})`;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();

    // Faint shafts parallel to the light the canopy actually receives, so the shading
    // direction reads at a glance.
    ctx.save();
    ctx.globalAlpha = 0.05 * vis * (0.4 + env.intensity);
    ctx.fillStyle = "#fff6d8";
    const len = horizonY - sunY + 40;
    for (let i = -3; i <= 3; i++) {
      const off = i * 70 * Math.max(0.6, zoom) + 14 * Math.sin(i * 2.3);
      const w = 18 + 10 * Math.abs(Math.cos(i * 1.7));
      const x0 = sunX + off;
      ctx.beginPath();
      ctx.moveTo(x0 - w / 2, sunY);
      ctx.lineTo(x0 + w / 2, sunY);
      ctx.lineTo(x0 + w / 2 + slope * len, sunY + len);
      ctx.lineTo(x0 - w / 2 + slope * len, sunY + len);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Clouds roll in with the rain and the storm.
  if (overcast > 0.02) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const speed = 0.006 + 0.004 * hash(i, 1) + env.wind * 0.05;
      const span = width + 400;
      const cx = ((hash(i, 2) * span + env.now * speed) % span) - 200;
      const cy =
        horizonY -
        Math.min(skyH * 0.7, horizonY - 30) * (0.4 + 0.6 * hash(i, 3));
      const rx = 120 + 120 * hash(i, 4);
      const ry = 26 + 16 * hash(i, 5);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      const a = overcast * 0.55;
      cg.addColorStop(0, `rgba(70,76,88,${a})`);
      cg.addColorStop(1, "rgba(70,76,88,0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = cg;
      ctx.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
      ctx.restore();
    }
  }
}

// Rain (or snow in winter) and the lightning flash, drawn over the tree but clipped to the
// sky so nothing falls into the soil. `skyline` holds the ground's screen y per
// SKYLINE_STEP px column.
export const SKYLINE_STEP = 8;
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  skyline: Float32Array,
  env: SceneEnv,
): void {
  if (env.rain > 0.02) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let i = 0; i < skyline.length; i++)
      ctx.lineTo(i * SKYLINE_STEP, skyline[i]);
    ctx.lineTo(width, 0);
    ctx.closePath();
    ctx.clip();

    const snow = env.season === "winter";
    const count = Math.min(
      450,
      Math.round(((width * height) / (snow ? 5000 : 3200)) * env.rain),
    );
    const t = env.now;
    if (snow) {
      ctx.fillStyle = "rgba(240,246,255,0.85)";
      for (let i = 0; i < count; i++) {
        const fall = 0.03 + 0.03 * hash(i, 7);
        const y = (hash(i, 8) * height + t * fall) % height;
        const x =
          (hash(i, 9) * width +
            Math.sin(t * 0.0015 + i) * 12 +
            t * env.wind * 0.08) %
          width;
        const s = 1.2 + 1.6 * hash(i, 10);
        ctx.fillRect(x, y, s, s);
      }
    } else {
      // Streaks lean with the wind; a storm drives them nearly sideways.
      const lean = 0.12 + env.wind * 0.9;
      ctx.strokeStyle = `rgba(200,215,235,${0.25 + 0.2 * env.rain})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const fall = 0.7 + 0.4 * hash(i, 7);
        const len = 10 + 8 * hash(i, 11);
        const y = (hash(i, 8) * (height + len) + t * fall) % (height + len);
        const x = (((hash(i, 9) * width + y * lean) % width) + width) % width;
        ctx.moveTo(x, y - len);
        ctx.lineTo(x + len * lean, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  if (env.flash > 0.01) {
    ctx.fillStyle = `rgba(235,240,255,${env.flash * 0.55})`;
    ctx.fillRect(0, 0, width, height);
  }
}

// Stable pseudo-random in [0, 1) per (index, channel), so particles need no stored state.
function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
