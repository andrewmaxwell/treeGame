import { describe, it, expect } from "vitest";
import { createInitialState, randomWorld } from "./state";

describe("worlds", () => {
  it("a world number fixes the run's random streams", () => {
    const a = createInitialState(48213);
    const b = createInitialState(48213);
    expect(a.worldSeed).toBe(48213);
    expect(a.rngSeed).toBe(b.rngSeed);
    expect(createInitialState(48214).rngSeed).not.toBe(a.rngSeed);
  });

  it("new worlds get short five-digit numbers for links", () => {
    for (let i = 0; i < 50; i++) {
      const w = randomWorld();
      expect(w).toBeGreaterThanOrEqual(10000);
      expect(w).toBeLessThan(100000);
    }
  });
});
