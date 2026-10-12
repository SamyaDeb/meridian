import { describe, expect, it } from "vitest";
import { gasLimitFor, resolveSwapMarket, shouldPokePerpl, sourceLagBlocks, type SwapMarketRecord } from "../src/perplsource.js";

// Recorded views, Monad testnet 10143 (docs/PERPL_SWAPS.md §Units): Perpl perp 64 feb 70,436,478 applied while the
// source (deployed at 70,443,829) still held it; the next event applied at 70,445,049 = 70,436,478 + 8,571.
const FEB_A = 70_436_478n;
const FEB_B = 70_445_049n;
const base = { perplFeb: FEB_A, sourceFeb: FEB_A, pending: false, block: 70_444_000n, lastFailedBlock: -1n, retryAfterBlocks: 10n };

describe("shouldPokePerpl", () => {
  it("does nothing while Perpl has no new funding event", () => {
    expect(shouldPokePerpl(base)).toBe(false);
  });
  it("pokes once Perpl applied a new event the source has not snapshotted", () => {
    expect(shouldPokePerpl({ ...base, perplFeb: FEB_B, block: FEB_B + 3n })).toBe(true);
  });
  it("one poke per event: not while ours is pending", () => {
    expect(shouldPokePerpl({ ...base, perplFeb: FEB_B, block: FEB_B + 3n, pending: true })).toBe(false);
  });
  it("catches up several missed events with one poke", () => {
    expect(shouldPokePerpl({ ...base, perplFeb: FEB_B + 2n * 8571n, block: FEB_B + 2n * 8571n + 1n })).toBe(true);
  });
  it("backs off after a reverted poke (stale Perpl price), then retries", () => {
    const failed = { ...base, perplFeb: FEB_B, lastFailedBlock: FEB_B + 3n };
    expect(shouldPokePerpl({ ...failed, block: FEB_B + 9n })).toBe(false);
    expect(shouldPokePerpl({ ...failed, block: FEB_B + 13n })).toBe(true);
  });
  it("never pokes when the source is ahead (Perpl admin rewound its event block)", () => {
    expect(shouldPokePerpl({ ...base, perplFeb: FEB_A - 8571n })).toBe(false);
  });
});

describe("gasLimitFor / sourceLagBlocks", () => {
  it("estimate × 1.2, rounded up", () => {
    expect(gasLimitFor(100_000n)).toBe(120_000n);
    expect(gasLimitFor(95_029n)).toBe(114_035n);
  });
  it("lag", () => {
    expect(sourceLagBlocks(FEB_B, FEB_A)).toBe(8571n);
    expect(sourceLagBlocks(FEB_A, FEB_B)).toBe(0n);
  });
});

describe("resolveSwapMarket", () => {
  const entry: SwapMarketRecord = {
    symbol: "MON-FUNDING-PERPL",
    fundingSource: "perpl",
    perplPerpId: 64,
    perplExchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    PerplFundingSource: "0xC008aF47fCC651889a1d66f0734da941A55224cC",
    FundingSwapMarket: "0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde",
    SwapOrderBook: "0x5D4f03B6Afa525ed580C75878A2F51A35c202334",
    tickSizeWad: "100000000000000",
    lotSizeWad: "1000000000000000000000",
    maturity: 1_794_414_069,
    startBlock: 70_443_746,
    deployed: true,
  };
  it("by symbol or by 'perpl'", () => {
    expect(resolveSwapMarket({ swapMarkets: [entry] }, "mon-funding-perpl").FundingSwapMarket).toBe(entry.FundingSwapMarket);
    expect(resolveSwapMarket({ swapMarkets: [entry] }, "perpl").PerplFundingSource).toBe(entry.PerplFundingSource);
  });
  it("refuses a record without deployed: true", () => {
    expect(() => resolveSwapMarket({ swapMarkets: [{ ...entry, deployed: false }] }, "perpl")).toThrow(/not deployed/);
  });
  it("refuses an unknown key and a record without swapMarkets", () => {
    expect(() => resolveSwapMarket({ swapMarkets: [entry] }, "ETH-FUNDING")).toThrow(/not in deployments/);
    expect(() => resolveSwapMarket({}, "perpl")).toThrow(/none/);
  });
});
