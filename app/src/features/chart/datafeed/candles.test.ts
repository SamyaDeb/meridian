import { describe, expect, it } from "vitest";
import { aggregate, applyTrade, fillGaps } from "./candles";
import type { Bar } from "./types";

// deterministic PRNG (mulberry32) so property tests are reproducible
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomBars(seed: number, n: number, sec = 60, start = 1_700_000_040): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let px = 27_000n * 10n ** 12n;
  let t = start;
  for (let i = 0; i < n; i++) {
    t += sec * (1 + Math.floor(r() * 3)); // random gaps
    const o = px;
    const c = px + BigInt(Math.floor((r() - 0.5) * 200)) * 10n ** 12n;
    const hi = (o > c ? o : c) + BigInt(Math.floor(r() * 50)) * 10n ** 12n;
    const lo = (o < c ? o : c) - BigInt(Math.floor(r() * 50)) * 10n ** 12n;
    const vb = BigInt(Math.floor(r() * 10)) * 100n * 10n ** 18n;
    out.push({ time: t, open: o, high: hi, low: lo, close: c, volumeBaseWad: vb, volumeQuoteWad: vb * 27n, trades: Math.floor(r() * 5) });
    px = c;
  }
  return out;
}
const sum = (bars: Bar[], k: "volumeBaseWad" | "volumeQuoteWad") => bars.reduce((s, b) => s + b[k], 0n);

describe("aggregate: property tests over 200 seeded random series", () => {
  for (const target of [300, 900, 3_600, 14_400, 86_400]) {
    it(`OHLC invariants, volume and trade conservation, UTC alignment at ${target}s`, () => {
      for (let seed = 1; seed <= 200; seed++) {
        const src = randomBars(seed, 120);
        const out = aggregate(src, target);
        for (const b of out) {
          expect(b.low <= b.open && b.open <= b.high).toBe(true);
          expect(b.low <= b.close && b.close <= b.high).toBe(true);
          expect(b.time % target).toBe(0);
        }
        expect(sum(out, "volumeBaseWad")).toBe(sum(src, "volumeBaseWad"));
        expect(sum(out, "volumeQuoteWad")).toBe(sum(src, "volumeQuoteWad"));
        expect(out.reduce((s, b) => s + b.trades, 0)).toBe(src.reduce((s, b) => s + b.trades, 0));
        // strictly increasing buckets
        for (let i = 1; i < out.length; i++) expect(out[i]!.time).toBeGreaterThan(out[i - 1]!.time);
        // first open / last close preserved
        expect(out[0]!.open).toBe(src[0]!.open);
        expect(out[out.length - 1]!.close).toBe(src[src.length - 1]!.close);
      }
    });
  }
  it("is associative: 1m → 5m → 15m equals 1m → 15m", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const src = randomBars(seed, 200);
      expect(aggregate(aggregate(src, 300), 900)).toEqual(aggregate(src, 900));
    }
  });
  it("order of input does not matter", () => {
    const src = randomBars(7, 50);
    expect(aggregate([...src].reverse(), 900)).toEqual(aggregate(src, 900));
  });
});

describe("gap fill", () => {
  it("carries the previous close with zero volume, flagged, never invented prices", () => {
    const bars: Bar[] = [
      { time: 0, open: 5n, high: 9n, low: 4n, close: 7n, volumeBaseWad: 1n, volumeQuoteWad: 1n, trades: 1 },
      { time: 180, open: 8n, high: 8n, low: 8n, close: 8n, volumeBaseWad: 2n, volumeQuoteWad: 2n, trades: 1 },
    ];
    const f = fillGaps(bars, 60);
    expect(f.map((b) => b.time)).toEqual([0, 60, 120, 180]);
    expect(f[1]).toEqual({ time: 60, open: 7n, high: 7n, low: 7n, close: 7n, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0, gapFill: true });
    expect(sum(f, "volumeBaseWad")).toBe(3n);
  });
  it("aggregating gap-filled bars keeps volume and drops the flag once a real bar joins", () => {
    const src = randomBars(3, 60);
    const filled = aggregate(src, 60, true);
    expect(sum(filled, "volumeBaseWad")).toBe(sum(src, "volumeBaseWad"));
    const coarse = aggregate(filled, 3_600);
    for (const b of coarse) if (b.trades > 0) expect(b.gapFill).toBeUndefined();
  });
  it("is bounded", () => {
    const f = fillGaps([{ time: 0, open: 1n, high: 1n, low: 1n, close: 1n, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 }, { time: 60 * 1e7, open: 1n, high: 1n, low: 1n, close: 1n, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 }], 60, 100);
    expect(f.length).toBeLessThanOrEqual(100);
  });
});

describe("applyTrade (live per-block bar)", () => {
  const base: Bar[] = [{ time: 120, open: 10n, high: 12n, low: 9n, close: 11n, volumeBaseWad: 1n, volumeQuoteWad: 10n, trades: 1 }];
  it("extends the current bucket: high/low/close/volume", () => {
    const u = applyTrade(base, 60, 150, 13n, 2n, 26n);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ open: 10n, high: 13n, low: 9n, close: 13n, volumeBaseWad: 3n, volumeQuoteWad: 36n, trades: 2 });
    expect(base[0]!.close).toBe(11n); // input untouched
  });
  it("opens a new bucket, ignores late trades", () => {
    expect(applyTrade(base, 60, 200, 8n, 1n, 8n)[1]).toMatchObject({ time: 180, open: 8n, close: 8n });
    expect(applyTrade(base, 60, 30, 99n, 1n, 1n)).toEqual(base);
  });
  it("live updates keep OHLC invariants (sweep)", () => {
    let bars: Bar[] = [];
    const r = rng(11);
    for (let i = 0; i < 2_000; i++) bars = applyTrade(bars, 60, 1_000 + i * 7, BigInt(1 + Math.floor(r() * 1_000)), 1n, 1n);
    for (const b of bars) expect(b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high).toBe(true);
    expect(sum(bars, "volumeBaseWad")).toBe(2_000n);
  });
});

describe("price-only live overlay", () => {
  it("is idempotent: applying the same trades twice changes nothing", async () => {
    const { applyTrade: ap } = await import("./candles");
    const base: Bar[] = [{ time: 120, open: 10n, high: 12n, low: 9n, close: 11n, volumeBaseWad: 5n, volumeQuoteWad: 50n, trades: 3 }];
    const once = [13n, 8n, 10n].reduce((b, px, i) => ap(b, 60, 125 + i, px, 0n, 0n, false), base);
    const twice = [13n, 8n, 10n].reduce((b, px, i) => ap(b, 60, 125 + i, px, 0n, 0n, false), once);
    expect(twice).toEqual(once);
    expect(once[0]).toMatchObject({ high: 13n, low: 8n, close: 10n, volumeBaseWad: 5n, trades: 3 });
  });
});
