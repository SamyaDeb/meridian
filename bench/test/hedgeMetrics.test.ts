import { describe, expect, it } from "vitest";
import { bookMetrics, countEvidence, fromCsv, markdownTable, percentile, summarize, toCsv, type Row } from "../src/hedgeMetrics";

const T = 10n ** 13n; // tick 0.00001 (WAD)
const idx = 2_578n * T; // 0.02578

describe("bookMetrics", () => {
  it("inner spread vs mid, depth within ±1% of the index per side", () => {
    const m = bookMetrics(
      [
        { tick: 2_570, lots: 20n },
        { tick: 2_560, lots: 20n },
        { tick: 2_500, lots: 99n }, // −3%: outside the band
      ],
      [
        { tick: 2_586, lots: 20n },
        { tick: 2_603, lots: 5n }, // +0.97%: inside
        { tick: 2_700, lots: 99n },
      ],
      T,
      idx,
    );
    expect(m).toMatchObject({ bestBidTick: 2_570, bestAskTick: 2_586, bidDepthLots: 40n, askDepthLots: 25n, oneSided: "none" });
    expect(m.innerSpreadBps).toBeCloseTo((16 / 2_578) * 1e4, 1);
  });
  it("one-sided and empty books", () => {
    expect(bookMetrics([{ tick: 1, lots: 1n }], [], T, idx)).toMatchObject({ oneSided: "bid-only", innerSpreadBps: null });
    expect(bookMetrics([], [{ tick: 9, lots: 1n }], T, idx).oneSided).toBe("ask-only");
    expect(bookMetrics([{ tick: 5, lots: 0n }], [], T, idx).oneSided).toBe("empty");
  });
});

const row = (over: Partial<Row>): Row => ({ t: 1, phase: "on", block: 10n, bestBidTick: 1, bestAskTick: 2, innerSpreadBps: 10, bidDepthLots: 60n, askDepthLots: 60n, oneSided: "none", merPosMon: 0, perplPosMon: null, ...over });

describe("summarize / csv / evidence", () => {
  it("percentiles (nearest rank), one-sided share, |net delta| uses Perpl when known", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    const s = summarize([row({ merPosMon: 8_000, perplPosMon: -7_000 }), row({ merPosMon: -2_000 }), row({ oneSided: "ask-only", innerSpreadBps: null, merPosMon: 100, perplPosMon: 0 })]);
    expect(s).toMatchObject({ samples: 3, spreadP50Bps: 10, oneSidedPct: (100 * 1) / 3, absNetDeltaMaxMon: 2_000, absNetDeltaP50Mon: 1_000 });
  });
  it("csv round trip", () => {
    const r = row({ block: 69_000_000n, perplPosMon: -12, bestAskTick: null, innerSpreadBps: null, oneSided: "bid-only" });
    expect(fromCsv(toCsv(r))).toEqual(r);
  });
  it("evidence counts (mm-bot HEDGE_EVIDENCE lines)", () => {
    const lines = [
      { kind: "hedge-sent" },
      { kind: "hedge-outcome", outcome: { os: 100, fs: 100 }, fills: [{}, {}] },
      { kind: "hedge-sent" },
      { kind: "hedge-outcome", outcome: { os: 100, fs: 40 }, fills: [{}] },
      { kind: "hedge-sent" },
      { kind: "hedge-outcome", outcome: { os: 100, fs: 0 }, fills: [] },
      { kind: "hedge-rejected" },
      { kind: "hedge-unknown" },
      { kind: "halt" },
    ].map((x) => JSON.stringify(x));
    expect(countEvidence([...lines, ""])).toEqual({ hedges: 3, filled: 1, partial: 1, noFill: 1, rejected: 1, unknown: 1, perplFills: 3 });
  });
  it("markdown table has both columns", () => {
    const s = summarize([row({})]);
    const z = countEvidence([]);
    const md = markdownTable(s, s, { off: z, on: z });
    expect(md.split("\n")[0]).toBe("| metric | hedge off | hedge on |");
    expect(md).toMatch(/time one-sided \(%\) \| 0\.0 \| 0\.0/);
  });
});
