import { describe, it, expect } from "vitest";
import { TerrainGen, surfaceR } from "./terrain";
import { GROUND_WATER_CAP } from "./cells";

// Count terrain cell types across a wide swath at a given depth-band. Ground water is very
// rare, so use a wide q-span to keep the rare-event counts statistically stable.
function scan(t: TerrainGen, dLo: number, dHi: number, qSpan = 1500) {
  let gw = 0,
    rock = 0,
    soil = 0,
    n = 0;
  for (let q = -qSpan; q <= qSpan; q++) {
    const sr = surfaceR(q);
    for (let d = dLo; d <= dHi; d++) {
      const c = t.get(q, sr + d);
      if (!c) continue;
      n++;
      if (c.type === "ground water") gw++;
      else if (c.type === "rock") rock++;
      else if (c.type === "soil") soil++;
    }
  }
  return { gw, rock, soil, n };
}

describe("ground water terrain generation", () => {
  it("never appears above the minimum depth (GW_MIN_DEPTH = 25)", () => {
    const t = new TerrainGen();
    expect(scan(t, 0, 24).gw).toBe(0);
  });

  it("appears only as a very rare deep jackpot, denser the deeper you go", () => {
    const t = new TerrainGen();
    const upper = scan(t, 25, 34); // just past the gate
    const deeper = scan(t, 40, 49); // committed-deep
    expect(upper.gw).toBeGreaterThan(0); // reachable (was unreachable at depth ≥ 100)
    // Genuinely rare at every reachable depth — a jackpot, not a layer (<1%).
    expect(upper.gw / upper.n).toBeLessThan(0.01);
    expect(deeper.gw / deeper.n).toBeLessThan(0.01);
    // The payoff grows with depth (the reason to commit roots deep).
    expect(deeper.gw / deeper.n).toBeGreaterThan(upper.gw / upper.n);
  });

  it("carries the infinite-supply sentinel as its stored water", () => {
    const t = new TerrainGen();
    let found = false;
    for (let q = -1500; q <= 1500 && !found; q++) {
      const sr = surfaceR(q);
      for (let d = 25; d <= 49; d++) {
        const c = t.get(q, sr + d);
        if (c?.type === "ground water") {
          expect(c.water).toBe(GROUND_WATER_CAP);
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });
});
