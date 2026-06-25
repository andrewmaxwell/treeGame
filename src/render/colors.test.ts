import { describe, it, expect } from "vitest";
import { overlayColor } from "./colors";

function rgb(s: string): [number, number, number] {
  const m = s.match(/-?\d+/g)!;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

describe("overlayColor", () => {
  it("water ramps from dark (empty) to bright blue (full)", () => {
    const empty = rgb(overlayColor(0, "water"));
    const full = rgb(overlayColor(1, "water"));
    expect(full[2]).toBeGreaterThan(empty[2]); // bluer when full
    expect(full[0] + full[1] + full[2]).toBeGreaterThan(
      empty[0] + empty[1] + empty[2],
    ); // brighter
  });

  it("energy ramps from dark (empty) to bright gold (full)", () => {
    const empty = rgb(overlayColor(0, "energy"));
    const full = rgb(overlayColor(1, "energy"));
    expect(full[0]).toBeGreaterThan(empty[0]); // redder/golder when full
    expect(full[1]).toBeGreaterThan(empty[1]);
  });

  it("clamps out-of-range levels", () => {
    expect(overlayColor(-5, "water")).toBe(overlayColor(0, "water"));
    expect(overlayColor(5, "energy")).toBe(overlayColor(1, "energy"));
  });
});
