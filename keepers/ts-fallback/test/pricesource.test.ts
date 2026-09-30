import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { applyFactor, decimalToWad, feedPoint, encodeTestOracleUpdate, parseHyperliquidMid, pythPriceToPoint } from "../src/pricesource.js";
import { shouldPushPyth } from "../src/decide.js";

describe("pythPriceToPoint (mirrors the adapter's checks)", () => {
  it("converts the 30 Sep mainnet sample: 2715623e-8 ⇒ 0.02715623", () => {
    expect(pythPriceToPoint({ price: 2_715_623n, conf: 528n, expo: -8, publishTime: 1_790_716_421n })).toEqual({
      priceWad: 27_156_230_000_000_000n,
      publishTime: 1_790_716_421n,
    });
  });
  it("rejects conf > 1%, non-positive price, bad expo", () => {
    expect(pythPriceToPoint({ price: 1000n, conf: 11n, expo: -8, publishTime: 1n })).toBeNull();
    expect(pythPriceToPoint({ price: 1000n, conf: 10n, expo: -8, publishTime: 1n })).not.toBeNull(); // exactly 1%
    expect(pythPriceToPoint({ price: 0n, conf: 0n, expo: -8, publishTime: 1n })).toBeNull();
    expect(pythPriceToPoint({ price: -5n, conf: 0n, expo: -8, publishTime: 1n })).toBeNull();
    expect(pythPriceToPoint({ price: 5n, conf: 0n, expo: -19, publishTime: 1n })).toBeNull();
    expect(pythPriceToPoint({ price: 5n, conf: 0n, expo: 1, publishTime: 1n })).toBeNull();
  });
});

describe("decimalToWad", () => {
  it("is exact", () => {
    expect(decimalToWad("0.027147")).toBe(27_147_000_000_000_000n);
    expect(decimalToWad("1")).toBe(10n ** 18n);
    expect(decimalToWad("12.5")).toBe(12_500_000_000_000_000_000n);
    expect(decimalToWad("0.000000000000000001")).toBe(1n);
  });
  it("rejects junk, zero, negatives, > 18 dp, exponents", () => {
    for (const s of ["", "abc", "0", "0.0", "-1", "1e-3", "0.0000000000000000001", "1.", ".5"]) expect(decimalToWad(s), s).toBeNull();
  });
});

describe("parseHyperliquidMid", () => {
  it("reads the coin", () => {
    expect(parseHyperliquidMid({ BTC: "100000.0", MON: "0.027147" }, "MON")).toBe(27_147_000_000_000_000n);
  });
  it("null when missing or malformed", () => {
    expect(parseHyperliquidMid({ BTC: "1" }, "MON")).toBeNull();
    expect(parseHyperliquidMid({ MON: 0.027 }, "MON")).toBeNull();
    expect(parseHyperliquidMid(null, "MON")).toBeNull();
    expect(parseHyperliquidMid("x", "MON")).toBeNull();
  });
});

describe("applyFactor (demo crash lever)", () => {
  it("scales and rounds down", () => {
    expect(applyFactor(29_000_000_000_000_000n, 850_000_000_000_000_000n)).toBe(24_650_000_000_000_000n);
    expect(applyFactor(3n, 500_000_000_000_000_000n)).toBe(1n);
    expect(applyFactor(10n ** 18n, 10n ** 18n)).toBe(10n ** 18n);
  });
  it("refuses a non-positive factor", () => {
    expect(() => applyFactor(1n, 0n)).toThrow();
  });
});

describe("encodeTestOracleUpdate", () => {
  it("round-trips (uint256 price, uint256 publishTime)", () => {
    const [d] = encodeTestOracleUpdate({ priceWad: 29_000_000_000_000_000n, publishTime: 1_790_716_421n });
    expect(d).toBeDefined();
    const [p, t] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], d!);
    expect(p).toBe(29_000_000_000_000_000n);
    expect(t).toBe(1_790_716_421n);
  });
});

describe("keeper-fed push rule = shouldPushPyth with the testnet heartbeat", () => {
  const on = { priceWad: 29_000_000_000_000_000n, publishTime: 100n };
  it("heartbeat: pushes when the onchain value is older than maxAge and the source is newer", () => {
    expect(shouldPushPyth({ nowSec: 111n, onchain: on, offchain: { ...on, publishTime: 110n }, maxAgeSec: 10n, maxMoveBps: 5n })).toBe("stale");
    expect(shouldPushPyth({ nowSec: 110n, onchain: on, offchain: { ...on, publishTime: 110n }, maxAgeSec: 10n, maxMoveBps: 5n })).toBeNull();
  });
  it("moves > 5 bps push early; a not-newer source never pushes", () => {
    const moved = { priceWad: on.priceWad + (on.priceWad * 6n) / 10_000n, publishTime: 101n };
    expect(shouldPushPyth({ nowSec: 101n, onchain: on, offchain: moved, maxAgeSec: 10n, maxMoveBps: 5n })).toBe("moved");
    expect(shouldPushPyth({ nowSec: 200n, onchain: on, offchain: { ...moved, publishTime: 100n }, maxAgeSec: 10n, maxMoveBps: 5n })).toBeNull();
  });
});

describe("feedPoint", () => {
  const src = { priceWad: 29_000_000_000_000_000n, publishTime: 100n };
  it("main market: the source as is, factor ignored", () => {
    expect(feedPoint(src, 850_000_000_000_000_000n, 130n, false)).toEqual(src);
  });
  it("demo market: price × factor, publish time = max(source, now) so the crash pushes next block", () => {
    expect(feedPoint(src, 850_000_000_000_000_000n, 130n, true)).toEqual({ priceWad: 24_650_000_000_000_000n, publishTime: 130n });
    expect(feedPoint({ ...src, publishTime: 140n }, 10n ** 18n, 130n, true).publishTime).toBe(140n);
  });
});
