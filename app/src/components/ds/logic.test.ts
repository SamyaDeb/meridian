import { describe, expect, it } from "vitest";
import { nextTabIndex, signGlyph, tickDirection, virtualWindow } from "./logic";

describe("virtualWindow", () => {
  it("renders only the visible rows plus overscan, and spacers keep the total height", () => {
    const w = virtualWindow(3_600, 360, 36, 1_000, 6); // row 100 at the top, 10 visible
    expect(w.start).toBe(94);
    expect(w.end).toBe(94 + 10 + 12);
    expect(w.padTop + (w.end - w.start) * 36 + w.padBottom).toBe(1_000 * 36);
  });
  it("clamps at the start and the end", () => {
    expect(virtualWindow(0, 360, 36, 1_000).start).toBe(0);
    const end = virtualWindow(1e9, 360, 36, 1_000);
    expect(end.end).toBe(1_000);
    expect(end.padBottom).toBe(0);
    expect(end.start).toBeLessThanOrEqual(end.end);
  });
  it("never renders more rows than exist and handles empty / degenerate input", () => {
    expect(virtualWindow(0, 10_000, 36, 5)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
    expect(virtualWindow(0, 360, 36, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(virtualWindow(-50, 360, 0, 10)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
  it("conserves total height for every scroll position (sweep)", () => {
    for (let top = 0; top < 40_000; top += 777) {
      const w = virtualWindow(top, 320, 32, 1_200, 4);
      expect(w.padTop + (w.end - w.start) * 32 + w.padBottom).toBe(1_200 * 32);
    }
  });
});

describe("tickDirection", () => {
  it("first render never flashes; equal values never flash", () => {
    expect(tickDirection(undefined, 5n)).toBe("none");
    expect(tickDirection(5n, 5n)).toBe("none");
  });
  it("up / down by bigint comparison (no float precision loss at WAD)", () => {
    expect(tickDirection(10n ** 30n, 10n ** 30n + 1n)).toBe("up");
    expect(tickDirection(-1n, -2n)).toBe("down");
  });
});

describe("nextTabIndex", () => {
  it("wraps with arrows and jumps with Home / End", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });
  it("ignores other keys and empty lists", () => {
    expect(nextTabIndex("Enter", 0, 3)).toBeUndefined();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeUndefined();
  });
});

describe("signGlyph", () => {
  it("gives a non-colour direction cue", () => {
    expect(signGlyph(1n)).toBe("+");
    expect(signGlyph(-1n)).toBe("−");
    expect(signGlyph(0n)).toBe("");
  });
});
