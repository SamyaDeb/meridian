import { describe, expect, it } from "vitest";
import { depthPaths } from "./depth";

const L = (p: bigint, s: bigint) => ({ priceWad: p, sizeWad: s });

describe("depthPaths", () => {
  it("cumulative steps on a shared scale; deepest side reaches the top", () => {
    const r = depthPaths([L(99n, 1n), L(98n, 3n)], [L(101n, 2n), L(102n, 2n)], 100, 50)!;
    expect(r.maxCum).toBe(4n);
    expect(r.bid[r.bid.length - 1]!.y).toBe(0); // bids total 4 = max ⇒ top
    expect(r.ask[r.ask.length - 1]!.y).toBe(0); // asks total 4 too
    expect(r.bid[0]).toEqual({ x: 25, y: 50 }); // best bid at 99 in [98,102] ⇒ x = 25, starts at the bottom
    expect(r.ask[1]!.y).toBe(25); // 2 of 4 ⇒ halfway
  });
  it("x is monotone: bids leftwards, asks rightwards from the spread", () => {
    const r = depthPaths([L(99n, 1n), L(97n, 1n)], [L(101n, 1n), L(103n, 1n)], 200, 10)!;
    expect(r.bid[0]!.x).toBeGreaterThan(r.bid[r.bid.length - 1]!.x);
    expect(r.ask[0]!.x).toBeLessThan(r.ask[r.ask.length - 1]!.x);
    expect(r.bid[0]!.x).toBeLessThan(r.ask[0]!.x);
  });
  it("empty book ⇒ undefined; one side only still draws", () => {
    expect(depthPaths([], [], 10, 10)).toBeUndefined();
    expect(depthPaths([L(5n, 1n)], [], 10, 10)!.ask).toEqual([]);
  });
});
