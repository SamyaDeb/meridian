// Rounding against the user: deposits owed round up; IOC buy limits up, sells down; sizes floor to the lot.
import { pnsToWad } from "@meridian/core/perpl";
import { checkDeposit, formatUnitsExact, iocLimitPns, needsApprove, parseAmountUp, sizeLns, SMALLEST_LNS } from "../../venues/perpl/amounts";
import { limitPnsOf } from "../../venues/perpl/ioc";
import { deployment } from "./perplFixtures";

const WAD = 10n ** 18n;
const mon10143 = deployment(10143).markets[64]!; // priceDecimals 5, sizeDecimals 0 (deployments/perpl.json)
const mon143 = deployment(143).markets[10]!; // priceDecimals 6, sizeDecimals 0

describe("deposit amounts", () => {
  it("parses decimals, rounding past the token's precision UP", () => {
    expect(parseAmountUp("100", 6)).toBe(100_000_000n);
    expect(parseAmountUp("10.5", 6)).toBe(10_500_000n);
    expect(parseAmountUp(".5", 6)).toBe(500_000n);
    expect(parseAmountUp("1,000", 6)).toBe(1_000_000_000n);
    expect(parseAmountUp("0.0000001", 6)).toBe(1n);
    expect(parseAmountUp("0.0000000", 6)).toBe(0n);
    for (const bad of ["", ".", "-1", "1e3", "1.2.3", "abc", " 1 2"]) expect(parseAmountUp(bad, 6)).toBeUndefined();
  });
  it("formats exactly", () => {
    expect(formatUnitsExact(100_000_000n, 6)).toBe("100");
    expect(formatUnitsExact(10_000_000n, 6)).toBe("10");
    expect(formatUnitsExact(1n, 6)).toBe("0.000001");
  });
  it("opening an account needs ≥ the on-chain minimum (mainnet 10 AUSD, testnet 100, measured 9 Oct)", () => {
    const base = { walletBalance: 1_000_000_000n, decimals: 6, symbol: "AUSD", opensAccount: true };
    expect(checkDeposit({ ...base, amount: 9_999_999n, minOpen: 10_000_000n })).toMatchObject({ ok: false, error: expect.stringMatching(/at least 10 AUSD/) });
    expect(checkDeposit({ ...base, amount: 10_000_000n, minOpen: 10_000_000n })).toEqual({ ok: true, amount: 10_000_000n });
    expect(checkDeposit({ ...base, amount: 99_999_999n, minOpen: 100_000_000n }).ok).toBe(false);
    expect(checkDeposit({ ...base, amount: 100_000_000n, minOpen: undefined }).ok).toBe(false); // never without a fresh read
    expect(checkDeposit({ ...base, amount: 2_000_000_000n, minOpen: 100_000_000n })).toMatchObject({ ok: false, error: "You have 1000 AUSD" });
    expect(checkDeposit({ ...base, opensAccount: false, amount: 1n, minOpen: undefined })).toEqual({ ok: true, amount: 1n });
    expect(checkDeposit({ ...base, amount: 0n, minOpen: 1n }).ok).toBe(false);
  });
  it("approve only when the allowance doesn't already cover the exact amount", () => {
    expect(needsApprove(0n, 100n)).toBe(true);
    expect(needsApprove(99n, 100n)).toBe(true);
    expect(needsApprove(100n, 100n)).toBe(false);
  });
});

describe("IOC limit and size", () => {
  it("buy limit = ask·(1+s) rounded UP to the price step; sell = bid·(1−s) DOWN", () => {
    const ref = 2_587_123_456_789_000n; // 0.002587123… WAD-scaled
    const buy = iocLimitPns(ref * 10n, "buy", 100n, mon10143.priceDecimals);
    const sell = iocLimitPns(ref * 10n, "sell", 100n, mon10143.priceDecimals);
    expect(pnsToWad(buy, mon10143.priceDecimals)).toBeGreaterThanOrEqual((ref * 10n * 10_100n) / 10_000n);
    expect(pnsToWad(sell, mon10143.priceDecimals)).toBeLessThanOrEqual((ref * 10n * 9_900n) / 10_000n);
    expect(buy - sell).toBeGreaterThan(0);
    // exact step: 0.03 at 5 dp with 1% ⇒ buy 0.0303 = 3030, sell 0.0297 = 2970
    expect(iocLimitPns((3n * WAD) / 100n, "buy", 100n, 5)).toBe(3030);
    expect(iocLimitPns((3n * WAD) / 100n, "sell", 100n, 5)).toBe(2970);
    // one wei over a step ⇒ buy rounds up a whole step, sell stays
    expect(iocLimitPns((3n * WAD) / 100n + 1n, "buy", 0n, 5)).toBe(3001);
    expect(iocLimitPns((3n * WAD) / 100n + 1n, "sell", 0n, 5)).toBe(3000);
    expect(limitPnsOf((3n * WAD) / 100n + 1n, "buy", mon143.priceDecimals)).toBe(30001);
    expect(() => iocLimitPns(0n, "buy", 100n, 5)).toThrow();
    expect(() => iocLimitPns(WAD, "sell", 10_000n, 5)).toThrow();
  });
  it("size floors to the market's step; MON's smallest order is one unit (sizeDecimals 0 on both chains)", () => {
    expect(mon10143.sizeDecimals).toBe(0);
    expect(mon143.sizeDecimals).toBe(0);
    expect(sizeLns((19n * WAD) / 10n, 0)).toBe(1);
    expect(sizeLns(WAD - 1n, 0)).toBe(0);
    expect(sizeLns((123_456n * WAD) / 100_000n, 3)).toBe(1234);
    expect(SMALLEST_LNS).toBe(1);
  });
});
