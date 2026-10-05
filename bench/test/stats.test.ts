import { describe, expect, it } from "vitest";
import { GAS_CSV_HEADER, gasCsvRow, gasLimitFor, loadMix, meanBlockTimeMs, parseFoundryCsv, percentile, summarizeLoad } from "../src/stats.js";

describe("stats", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 0)).toBe(7);
    expect(() => percentile([], 50)).toThrow();
  });
  it("mean block time from timestamps (1 s resolution, R4)", () => {
    expect(meanBlockTimeMs({ number: 100n, timestamp: 1000n }, { number: 1100n, timestamp: 1300n })).toBe(300);
    expect(meanBlockTimeMs({ number: 1n, timestamp: 1n }, { number: 1n, timestamp: 1n })).toBe(0);
  });
  it("gas = estimate × 1.2 rounded up", () => {
    expect(gasLimitFor(100n)).toBe(120n);
    expect(gasLimitFor(7n)).toBe(9n);
    expect(gasLimitFor(137_000n, 70_000n)).toBe(234_400n);
  });
  it("CSV rows carry network, commit, date and block time (BENCHMARKS_PLAN)", () => {
    const row = gasCsvRow({ op: "place", gasUsed: 68576n, gasLimit: 82292n, block: 12n, txHash: "0xab" }, { commit: "abc123", date: "2026-09-30", chainId: 10143, blockTimeMs: 300 });
    expect(row).toBe("place,68576,82292,12,0xab,abc123,2026-09-30,10143,300.0");
    expect(GAS_CSV_HEADER.split(",")).toHaveLength(row.split(",").length);
  });
  it("parses the Foundry reference CSV", () => {
    const m = parseFoundryCsv("op,gas,target\nplace,68576,\nplace+cancel,96478,100000\n");
    expect(m.get("place")).toEqual({ gas: 68576, target: null });
    expect(m.get("place+cancel")).toEqual({ gas: 96478, target: 100000 });
  });
  it("B4 mix ≈ 70/30 and never cancels with nothing open", () => {
    const mix = loadMix(10_000, 42);
    const market = mix.filter((x) => x === "market").length / mix.length;
    expect(market).toBeGreaterThan(0.27);
    expect(market).toBeLessThan(0.33);
    let open = 0;
    for (const x of mix) {
      if (x === "place") ++open;
      if (x === "cancel") --open;
      expect(open).toBeGreaterThanOrEqual(0);
    }
    expect(loadMix(50, 7)).toEqual(loadMix(50, 7));
  });
  it("load summary", () => {
    const s = summarizeLoad(2, [300, 600, 900], 4, 10n, 12n);
    expect(s).toMatchObject({ markets: 2, sent: 4, included: 3, blocks: 3, txPerBlock: 1, latencyMsP50: 600, latencyMsP95: 900 });
  });
});

import { hasSide } from "../src/stats.js";
describe("hasSide (empty book sides in load.ts)", () => {
  it("0 = no bids, the uint32 sentinel = no asks", () => {
    expect(hasSide(0)).toBe(false);
    expect(hasSide(4_294_967_295)).toBe(false);
    expect(hasSide(26_600)).toBe(true);
  });
});

import { networkLabel } from "../src/stats.js";
describe("networkLabel (anvil outputs never look like testnet evidence)", () => {
  it("prefixes anvil nodes", () => {
    expect(networkLabel(10143, "anvil/v1.5.1")).toBe("anvil-10143");
    expect(networkLabel(10143, "Monad/0.12")).toBe("10143");
  });
});
