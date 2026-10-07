import { describe, expect, it } from "vitest";
import { decideHedge, divergenceBps, fundingTargetWad, haltReasons, quoteInventoryWad, scaledPriceToWad, scaledSizeToWad, type HedgeConfig, type HedgeInputs } from "../src/hedge";
import { OrderType } from "../src/perpl/types";

const E18 = 10n ** 18n;
const MON = (n: number | bigint) => BigInt(n) * E18;
// Perpl testnet MON market 64 (recorded 7 Oct 2026): price_decimals 5, size_decimals 0, book ≈ 0.02570 / 0.02586
const cfg: HedgeConfig = {
  enabled: true,
  maxInventoryWad: MON(20_000),
  bandBps: 2_500,
  residualWad: 0n,
  maxHedgePerOrderWad: MON(10_000),
  maxPerplNotionalWad: MON(1_000), // $1,000
  slippageBps: 50,
  maxDivergenceBps: 300,
  maxDataAgeMs: 15_000,
  maxConsecutiveRejects: 3,
  minCollateral: 50_000_000n, // 50 AUSD (6 dp)
  cooldownMs: 10_000,
  leverage: 500,
};
const base: HedgeInputs = {
  nowMs: 1_000_000,
  merPosWad: 0n,
  perplPosScaled: 0,
  sizeDecimals: 0,
  priceDecimals: 5,
  perplBid: 2_570,
  perplAsk: 2_586,
  meridianIndexWad: 2_578n * 10n ** 13n, // 0.02578
  perplDataAgeMs: 500,
  perplReady: true,
  fw: true,
  frozen: false,
  availableCollateral: 5_000_000_000n,
  marketOpen: true,
  consecutiveRejects: 0,
  lastHedgeMs: undefined,
  inFlight: false,
};
const at = (over: Partial<HedgeInputs>, c: HedgeConfig = cfg) => decideHedge(c, { ...base, ...over });

describe("decideHedge", () => {
  it("inside the band (25% of max inventory) ⇒ hold", () => {
    expect(at({ merPosWad: MON(5_000) })).toMatchObject({ action: "hold", reason: "inside band" });
    expect(at({ merPosWad: MON(-5_000) })).toMatchObject({ action: "hold", reason: "inside band" });
  });
  it("MM long 8,000 MON on Meridian ⇒ IOC OpenShort 8,000 on Perpl at mid − 50 bps (rounded toward mid)", () => {
    const d = at({ merPosWad: MON(8_000) });
    expect(d).toMatchObject({ action: "hedge", order: { side: "sell", orderType: OrderType.OpenShort, size: 8_000, flags: 4, leverage: 500 }, deltaWad: MON(8_000), deltaAfterWad: 0n });
    // mid 2578 ⇒ 2578 × 0.995 = 2565.11 ⇒ ceil 2566
    expect(d.action === "hedge" && d.order.price).toBe(2_566);
  });
  it("MM short ⇒ buy at mid + 50 bps, floor (2578 × 1.005 = 2590.89 ⇒ 2590)", () => {
    const d = at({ merPosWad: MON(-6_000) });
    expect(d).toMatchObject({ action: "hedge", order: { side: "buy", orderType: OrderType.OpenLong, size: 6_000, price: 2_590 } });
  });
  it("per-order cap and the residual", () => {
    expect(at({ merPosWad: MON(-15_000) })).toMatchObject({ order: { size: 10_000 } });
    expect(at({ merPosWad: MON(8_000) }, { ...cfg, residualWad: MON(1_000) })).toMatchObject({ order: { size: 7_000 }, deltaAfterWad: MON(1_000) });
  });
  it("reduces the opposite Perpl position with a reduce-only Close*, clamped to it (never inverts)", () => {
    // Meridian flattened while Perpl is still short 8,000 ⇒ Δ = −8,000 ⇒ buy back with CloseShort
    expect(at({ merPosWad: 0n, perplPosScaled: -8_000 })).toMatchObject({ order: { side: "buy", orderType: OrderType.CloseShort, size: 8_000 } });
    // Meridian flipped short 12,000 with Perpl short 3,000 ⇒ Δ = −15,000 ⇒ buy: close the 3,000 first
    expect(at({ merPosWad: MON(-12_000), perplPosScaled: -3_000 })).toMatchObject({ order: { orderType: OrderType.CloseShort, size: 3_000 } });
    expect(at({ merPosWad: MON(12_000), perplPosScaled: 2_000 })).toMatchObject({ order: { orderType: OrderType.CloseLong, size: 2_000 } });
  });
  it("Perpl notional cap: |perplPos after| × mid ≤ cap ($1,000 ⇒ 38,789 MON at 0.02578)", () => {
    const d = at({ merPosWad: MON(20_000), perplPosScaled: -35_000 }, { ...cfg, maxHedgePerOrderWad: MON(50_000) });
    // Δ = −15,000 ⇒ buy… CloseShort; use a growing case instead:
    expect(d).toMatchObject({ order: { orderType: OrderType.CloseShort } });
    const g = at({ merPosWad: MON(45_000), perplPosScaled: -35_000 }, { ...cfg, maxInventoryWad: MON(60_000), bandBps: 1_000, maxHedgePerOrderWad: MON(50_000) });
    expect(g).toMatchObject({ order: { side: "sell", orderType: OrderType.OpenShort, size: 3_789 } });
    const full = at({ merPosWad: MON(60_000), perplPosScaled: -38_789 }, { ...cfg, maxInventoryWad: MON(60_000), maxHedgePerOrderWad: MON(50_000) });
    expect(full).toMatchObject({ action: "hold", reason: expect.stringMatching(/cap/) });
  });
  it("price-divergence guard: testnet venues aren't arbitraged", () => {
    expect(at({ merPosWad: MON(8_000), meridianIndexWad: 3_000n * 10n ** 13n })).toMatchObject({ action: "hold", reason: expect.stringMatching(/diverge \d+ bps > 300/) });
    expect(divergenceBps(MON(103), MON(100))).toBe(300);
    expect(divergenceBps(MON(97), MON(100))).toBe(300);
    expect(divergenceBps(1n, 0n)).toBe(Infinity);
  });
  it("in-flight order and cool-down hold; a one-sided or crossed Perpl book holds", () => {
    expect(at({ merPosWad: MON(8_000), inFlight: true })).toMatchObject({ action: "hold", reason: expect.stringMatching(/awaiting/) });
    expect(at({ merPosWad: MON(8_000), lastHedgeMs: base.nowMs - 9_999 })).toMatchObject({ action: "hold", reason: "cool-down" });
    expect(at({ merPosWad: MON(8_000), lastHedgeMs: base.nowMs - 10_000 }).action).toBe("hedge");
    expect(at({ merPosWad: MON(8_000), perplBid: 0 })).toMatchObject({ action: "hold", reason: expect.stringMatching(/one-sided/) });
    expect(at({ merPosWad: MON(8_000), perplBid: 2_600, perplAsk: 2_590 })).toMatchObject({ action: "hold" });
  });
  it("size_decimals rounding toward zero: never over-hedge by a fraction", () => {
    const d = at({ merPosWad: MON(8_000) + 999_999_999_999_999_999n });
    expect(d).toMatchObject({ order: { size: 8_000 } });
    expect(at({ merPosWad: 5n * 10n ** 17n }, { ...cfg, bandBps: 0 })).toMatchObject({ action: "hold", reason: expect.stringMatching(/rounds to zero/) });
  });
});

describe("kill switch / circuit breaker (haltReasons)", () => {
  const reasons = (over: Partial<HedgeInputs>, c: HedgeConfig = cfg) => haltReasons(c, { ...base, ...over });
  it("healthy ⇒ none", () => expect(reasons({})).toEqual([]));
  it.each([
    ["stale data", { perplDataAgeMs: 15_001 }, /data 15001 ms old/],
    ["connection down", { perplDataAgeMs: Infinity, perplReady: false }, /connection down/],
    ["fw off", { fw: false }, /One-Click Trading/],
    ["no account yet", { fw: undefined }, /not seen/],
    ["frozen", { frozen: true }, /frozen/],
    ["low collateral", { availableCollateral: 49_999_999n }, /collateral 49999999 < min 50000000/],
    ["unknown collateral", { availableCollateral: undefined }, /collateral \? </],
    ["rejections", { consecutiveRejects: 3 }, /3 rejections/],
    ["market closed", { marketOpen: false }, /closed/],
  ] as [string, Partial<HedgeInputs>, RegExp][])("%s ⇒ halt", (_, over, re) => {
    expect(reasons(over).join("; ")).toMatch(re);
    expect(at({ ...over, merPosWad: MON(8_000) }).action).toBe("halt");
  });
  it("PERPL_HEDGE=0 ⇒ halt regardless", () => expect(decideHedge({ ...cfg, enabled: false }, base)).toEqual({ action: "halt", reasons: ["PERPL_HEDGE=0"] }));
});

describe("funding bias (off by default)", () => {
  const fb = { ...cfg, fundingBias: { minSpreadAprWad: E18 / 10n, residualWad: MON(1_000) } };
  it("off ⇒ target 0 whatever the rates", () => expect(fundingTargetWad(cfg, { meridianAprWad: E18, perplAprWad: E18 / 2n })).toBe(0n));
  it("both rates > 0 and |spread| ≥ 10% ⇒ keep a net SHORT residual (longs pay on both)", () => {
    expect(fundingTargetWad(fb, { meridianAprWad: E18, perplAprWad: E18 / 2n })).toBe(-MON(1_000));
    expect(fundingTargetWad(fb, { meridianAprWad: -E18, perplAprWad: -E18 / 2n })).toBe(MON(1_000));
  });
  it("opposite signs, or a small spread ⇒ no bias", () => {
    expect(fundingTargetWad(fb, { meridianAprWad: E18, perplAprWad: -E18 })).toBe(0n);
    expect(fundingTargetWad(fb, { meridianAprWad: E18, perplAprWad: E18 - 1n })).toBe(0n);
  });
  it("the hedge then targets Δ* instead of 0", () => {
    const d = at({ merPosWad: MON(8_000), rates: { meridianAprWad: E18, perplAprWad: E18 / 2n } }, fb);
    expect(d).toMatchObject({ action: "hedge", targetWad: -MON(1_000), order: { side: "sell", size: 9_000 }, deltaAfterWad: -MON(1_000) });
  });
});

describe("quoteInventoryWad (A–S q with the hedge)", () => {
  it("no hedge (undefined) ⇒ Meridian position unchanged — the PERPL_HEDGE=0 path", () => expect(quoteInventoryWad(MON(123), undefined)).toBe(MON(123)));
  it("stale Perpl state ⇒ not counted", () => expect(quoteInventoryWad(MON(8_000), { posScaled: -8_000, sizeDecimals: 0, fresh: false })).toBe(MON(8_000)));
  it("fresh ⇒ net delta", () => expect(quoteInventoryWad(MON(8_000), { posScaled: -7_500, sizeDecimals: 0, fresh: true })).toBe(MON(500)));
});

// ───────────── seeded fuzz: invariants over 20,000 random states ─────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
describe("fuzz (seeded): rounding direction and safety invariants", () => {
  it("never crosses the target, respects every cap, prices within slippage on the right side", () => {
    const r = rng(42);
    const int = (lo: number, hi: number) => Math.floor(lo + r() * (hi - lo + 1));
    let hedges = 0;
    for (let n = 0; n < 20_000; n++) {
      const sd = int(0, 4);
      const pd = int(1, 7);
      const c: HedgeConfig = {
        ...cfg,
        maxInventoryWad: MON(int(1, 50_000)),
        bandBps: int(0, 5_000),
        residualWad: MON(int(0, 2_000)),
        maxHedgePerOrderWad: MON(int(1, 20_000)),
        maxPerplNotionalWad: MON(int(1, 5_000)),
        slippageBps: int(0, 200),
        maxDivergenceBps: 10_000,
        ...(r() < 0.3 ? { fundingBias: { minSpreadAprWad: 0n, residualWad: MON(int(0, 3_000)) } } : {}),
      };
      const bid = int(1, 10 ** Math.min(pd, 6));
      const ask = bid + int(1, 50);
      const i: HedgeInputs = {
        ...base,
        sizeDecimals: sd,
        priceDecimals: pd,
        perplBid: bid,
        perplAsk: ask,
        meridianIndexWad: scaledPriceToWad(bid, pd),
        merPosWad: BigInt(int(-60_000, 60_000)) * E18 + BigInt(int(0, 1e9)) * 10n ** 9n,
        perplPosScaled: int(-40_000, 40_000) * 10 ** sd + int(0, 10 ** sd - 1),
        rates: { meridianAprWad: BigInt(int(-5, 5)) * E18, perplAprWad: BigInt(int(-5, 5)) * E18 },
      };
      const d = decideHedge(c, i);
      expect(d.action).not.toBe("halt");
      if (d.action !== "hedge") continue;
      hedges++;
      const o = d.order;
      const traded = scaledSizeToWad(o.size, sd);
      const signed = o.side === "buy" ? traded : -traded;
      const perplPos = scaledSizeToWad(i.perplPosScaled, sd);
      const errBefore = d.deltaWad - d.targetWad;
      const errAfter = errBefore + signed;
      // reduces the error, never past the target (no over-hedge), and only in the right direction
      expect(o.size).toBeGreaterThan(0);
      expect(errAfter < 0n ? -errAfter : errAfter).toBeLessThan(errBefore < 0n ? -errBefore : errBefore);
      if (errAfter !== 0n) expect(errAfter > 0n).toBe(errBefore > 0n);
      expect(traded <= c.maxHedgePerOrderWad).toBe(true);
      // Close* never inverts
      if (o.orderType === OrderType.CloseShort || o.orderType === OrderType.CloseLong) expect(traded <= (perplPos < 0n ? -perplPos : perplPos)).toBe(true);
      // notional cap when the order grows |perplPos|
      const after = perplPos + signed;
      const mid2 = BigInt(bid) + BigInt(ask);
      if ((after < 0n ? -after : after) > (perplPos < 0n ? -perplPos : perplPos)) expect(((after < 0n ? -after : after) * scaledPriceToWad(1, pd) * mid2) / 2n / E18 <= c.maxPerplNotionalWad).toBe(true);
      // IOC limit: side-correct, within slippage of mid, rounded toward mid
      const p2 = BigInt(o.price) * 2n;
      if (o.side === "buy") {
        expect(p2 + 1n >= mid2).toBe(true); // floor(mid·(1+s)): at worst half a tick under an x.5 mid
        expect(p2 * 10_000n <= mid2 * (10_000n + BigInt(c.slippageBps))).toBe(true);
      } else {
        expect(p2 <= mid2 + 1n).toBe(true);
        expect(p2 * 10_000n >= mid2 * (10_000n - BigInt(c.slippageBps))).toBe(true);
      }
    }
    expect(hedges).toBeGreaterThan(2_000);
  });
});
