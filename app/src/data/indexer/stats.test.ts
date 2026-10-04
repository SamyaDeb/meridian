import { describe, expect, it } from "vitest";
import { mmShareBps, parseIndexerStats } from "./stats";

const P = {
  externalUsers: 7,
  users: 10,
  perpVolumeQuoteWad: "1000000000000000000000",
  perpVolumeMmQuoteWad: "600000000000000000000",
  swapVolumeWad: "0",
  feesWad: "1500000000000000000",
  tvlToken: "2500000000",
  trades: "42",
  liquidations: 1,
  updatedBlock: "66931089",
};

describe("parseIndexerStats", () => {
  it("parses Hasura numerics (strings or numbers) into bigint/number", () => {
    const s = parseIndexerStats({
      ProtocolStats: [P],
      Market: [
        { id: "a", symbol: "MON-PERP", lastFundingBlock: "66931088", realizedApr1hWad: "109500050000000000", realizedApr8hWad: null, realizedApr24hWad: null },
      ],
    });
    expect(s).toMatchObject({ externalUsers: 7, users: 10, trades: 42, liquidations: 1, statsBlock: 66_931_089n, tvlToken: 2_500_000_000n });
    expect(s.perpVolumeMmQuoteWad).toBe(600n * 10n ** 18n);
    expect(s.funding).toEqual({ symbol: "MON-PERP", block: 66_931_088n, apr1hWad: 109_500_050_000_000_000n, apr8hWad: undefined, apr24hWad: undefined });
  });
  it("picks the most recently funded product market for the headline", () => {
    const s = parseIndexerStats({
      ProtocolStats: [P],
      Market: [
        { id: "old", symbol: "OLD", lastFundingBlock: "5" },
        { id: "new", symbol: "NEW", lastFundingBlock: "9" },
      ],
    });
    expect(s.funding?.symbol).toBe("NEW");
  });
  it("no ProtocolStats row or a garbled number ⇒ error (never a silent zero)", () => {
    expect(() => parseIndexerStats({ ProtocolStats: [] })).toThrow(/no ProtocolStats/);
    expect(() => parseIndexerStats(undefined)).toThrow();
    expect(() => parseIndexerStats({ ProtocolStats: [{ ...P, feesWad: "1.5" }] })).toThrow(/feesWad/);
    expect(() => parseIndexerStats({ ProtocolStats: [{ ...P, trades: null }] })).toThrow(/trades/);
  });
});

describe("mmShareBps", () => {
  it("rounds down; zero volume ⇒ 0", () => {
    expect(mmShareBps(1000n, 600n)).toBe(6000);
    expect(mmShareBps(3n, 1n)).toBe(3333);
    expect(mmShareBps(0n, 0n)).toBe(0);
  });
});
