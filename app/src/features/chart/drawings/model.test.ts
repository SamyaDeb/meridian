// One test (at least) per drawing tool plus the shared geometry.
import { describe, expect, it } from "vitest";
import type { Bar } from "../datafeed/types";
import { CLICKS, distToSegment, fibLevels, magnet, makeDrawing, measure, parseDrawings, plan, rayEnd, type Pt, type Tool } from "./model";

const P = (time: number, price: number): Pt => ({ time, price });

describe("makeDrawing: every tool", () => {
  const pts = [P(0, 1), P(60, 2), P(120, 0.5)];
  const tools: Tool[] = ["hline", "vline", "trend", "ray", "rect", "fib", "ruler", "long", "short"];
  for (const t of tools)
    it(`${t} needs ${CLICKS[t]} click(s)`, () => {
      expect(makeDrawing(t, pts.slice(0, CLICKS[t] - 1), "x")).toBeUndefined();
      const d = makeDrawing(t, pts.slice(0, CLICKS[t]), "x")!;
      expect(d.kind).toBe(t);
    });
  it("text needs a label; brush needs a path of ≥ 2 points", () => {
    expect(makeDrawing("text", [P(0, 1)], "x")).toBeUndefined();
    expect(makeDrawing("text", [P(0, 1)], "x", "breakout")).toMatchObject({ kind: "text", text: "breakout" });
    expect(makeDrawing("brush", [P(0, 1)], "x")).toBeUndefined();
    expect(makeDrawing("brush", pts, "x")).toMatchObject({ kind: "brush", pts });
  });
});

describe("fib", () => {
  it("0 % at the start, 100 % at the end, 50 % halfway", () => {
    const l = fibLevels(P(0, 10), P(60, 20));
    expect(l.find((x) => x.ratio === 0)!.price).toBe(20);
    expect(l.find((x) => x.ratio === 1)!.price).toBe(10);
    expect(l.find((x) => x.ratio === 0.5)!.price).toBe(15);
    expect(l.find((x) => x.ratio === 0.618)!.price).toBeCloseTo(13.82, 9);
  });
});

describe("ruler", () => {
  it("Δprice, %, bars and seconds", () => {
    expect(measure(P(0, 2), P(900, 2.5), 300)).toEqual({ dPrice: 0.5, pct: 25, bars: 3, seconds: 900 });
    expect(measure(P(0, 0), P(60, 1), 60).pct).toBe(0);
  });
});

describe("position planner (not an order)", () => {
  it("long: target above, stop below ⇒ R:R", () => {
    expect(plan("long", P(0, 10), P(0, 13), P(0, 9))).toEqual({ reward: 3, risk: 1, rr: 3, valid: true });
  });
  it("short mirrored; wrong-side points are invalid", () => {
    expect(plan("short", P(0, 10), P(0, 8), P(0, 11)).rr).toBe(2);
    expect(plan("long", P(0, 10), P(0, 9), P(0, 8)).valid).toBe(false);
  });
});

describe("magnet", () => {
  const bars: Bar[] = [{ time: 60, open: 10n * 10n ** 18n, high: 12n * 10n ** 18n, low: 9n * 10n ** 18n, close: 11n * 10n ** 18n, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 1 }];
  it("snaps to the nearest OHLC within tolerance and to the bar's time", () => {
    expect(magnet(P(75, 11.8), bars, 60, 0.5)).toEqual(P(60, 12));
    expect(magnet(P(75, 9.3), bars, 60, 0.5)).toEqual(P(60, 9));
  });
  it("leaves the point alone outside tolerance or off the data", () => {
    expect(magnet(P(75, 10.5), bars, 60, 0.2)).toEqual(P(60, 10.5));
    expect(magnet(P(500, 1), bars, 60, 5)).toEqual(P(500, 1));
  });
});

describe("hit test, ray, brush/vline/hline/rect geometry helpers", () => {
  it("segment distance (erase)", () => {
    expect(distToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(1, 1, 1, 1, 1, 1)).toBe(0);
  });
  it("ray extends to the right edge along the slope", () => {
    expect(rayEnd(0, 0, 10, 5, 100)).toEqual({ x: 100, y: 50 });
    expect(rayEnd(10, 5, 0, 0, 100)).toEqual({ x: 0, y: 0 });
  });
});

describe("persistence", () => {
  it("round-trips valid drawings and drops malformed ones", () => {
    const good = [makeDrawing("trend", [P(0, 1), P(60, 2)], "a")!, makeDrawing("text", [P(0, 1)], "b", "hi")!, makeDrawing("brush", [P(0, 1), P(1, 2)], "c")!, makeDrawing("short", [P(0, 3), P(0, 2), P(0, 4)], "d")!];
    const bad = [{ id: "x", kind: "trend", a: P(0, 1) }, { id: 1, kind: "hline", a: P(0, 1) }, { id: "y", kind: "laser" }, { id: "z", kind: "text", a: P(0, 1) }];
    expect(parseDrawings(JSON.stringify([...good, ...bad]))).toEqual(good);
    expect(parseDrawings("nope")).toEqual([]);
    expect(parseDrawings(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});
