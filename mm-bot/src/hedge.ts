// Perpl hedge policy (K3.3, docs/PERPL_HEDGE.md). Pure: no network, no clock; every input is passed in.
// The MM quotes MON-PERP on Meridian and carries inventory `merPos`; the hedge offsets it on Perpl's MON perp so that the
// net delta Δ = merPos + perplPos stays inside a band. With the hedge on, the A–S inventory term uses Δ (quoteInventory).
//
// Units: positions are signed MON in WAD (bigint). Perpl prices/sizes are scaled integers (market price_decimals /
// size_decimals, types.md "Scaling"). Perpl order sizes round TOWARD ZERO, so we never over-hedge.
import { OrderType, type OrderTypeT } from "./perpl/types.js";

const WAD = 10n ** 18n;
const abs = (x: bigint) => (x < 0n ? -x : x);
const sign = (x: bigint) => (x > 0n ? 1n : x < 0n ? -1n : 0n);
const pow10 = (n: number) => 10n ** BigInt(n);

export type HedgeConfig = {
  /** PERPL_HEDGE=1; false ⇒ halt (the MM behaves exactly as without a hedge) */
  enabled: boolean;
  /** the MM's inventory limit, MON WAD (MAX_INVENTORY_LOTS × lotSize) */
  maxInventoryWad: bigint;
  /** hedge only when |Δ − target| > band = bandBps × maxInventory / 10 000 (default 2 500 = 25%) */
  bandBps: number;
  /** leave this much |Δ| after a hedge (MON WAD; 0 = hedge to flat) */
  residualWad: bigint;
  /** largest single Perpl order (MON WAD) */
  maxHedgePerOrderWad: bigint;
  /** cap on |perplPos| × Perpl mid after the order, quote WAD */
  maxPerplNotionalWad: bigint;
  /** IOC limit = Perpl mid ± slippage (bps), rounded toward mid */
  slippageBps: number;
  /** skip when |perplMid / meridianIndex − 1| exceeds this (bps): testnet venues are not arbitraged */
  maxDivergenceBps: number;
  /** Perpl state (trading WS) older than this ⇒ halt */
  maxDataAgeMs: number;
  /** this many rejections/failures in a row ⇒ halt */
  maxConsecutiveRejects: number;
  /** available collateral (b − lb, token units) below this ⇒ halt */
  minCollateral: bigint;
  /** no new hedge within this long of the last one (keeps us far below 60 requests/min) */
  cooldownMs: number;
  /** Perpl leverage, hundredths (500 = 5×) */
  leverage: number;
  /** optional funding-aware residual (off by default; PERPL_HEDGE.md §funding bias) */
  fundingBias?: { minSpreadAprWad: bigint; residualWad: bigint };
};

export type HedgeInputs = {
  nowMs: number;
  /** Meridian MM position, MON WAD, + long */
  merPosWad: bigint;
  /** Perpl net position, scaled size, + long */
  perplPosScaled: number;
  sizeDecimals: number;
  priceDecimals: number;
  /** Perpl best bid / ask, scaled price (market-data or ticker) */
  perplBid: number;
  perplAsk: number;
  /** Meridian oracle index, WAD */
  meridianIndexWad: bigint;
  /** ms since the trading state was last confirmed (WS frame or REST snapshot) */
  perplDataAgeMs: number;
  /** trading connection signed in with all snapshots */
  perplReady: boolean;
  fw: boolean | undefined;
  frozen: boolean | undefined;
  availableCollateral: bigint | undefined;
  marketOpen: boolean;
  consecutiveRejects: number;
  lastHedgeMs: number | undefined;
  /** a Perpl order of ours is still awaiting its outcome */
  inFlight: boolean;
  /** MFI spread inputs (annualized WAD), when known */
  rates?: { meridianAprWad: bigint; perplAprWad: bigint };
};

export type HedgeOrder = {
  side: "buy" | "sell";
  orderType: OrderTypeT;
  /** scaled size (> 0) */
  size: number;
  /** IOC limit, scaled price */
  price: number;
  flags: 4;
  leverage: number;
};

export type HedgeDecision =
  | { action: "halt"; reasons: string[] }
  | { action: "hold"; reason: string; deltaWad: bigint; targetWad: bigint }
  | { action: "hedge"; order: HedgeOrder; deltaWad: bigint; targetWad: bigint; deltaAfterWad: bigint; divergenceBps: number };

/** Perpl scaled size → MON WAD (exact). */
export const scaledSizeToWad = (s: number, sizeDecimals: number): bigint => BigInt(s) * pow10(18 - sizeDecimals);
/** MON WAD → Perpl scaled size, toward zero. */
export const wadToScaledSize = (w: bigint, sizeDecimals: number): bigint => w / pow10(18 - sizeDecimals);
/** Perpl scaled price → WAD (exact). */
export const scaledPriceToWad = (p: number, priceDecimals: number): bigint => BigInt(p) * pow10(18 - priceDecimals);

/** |a/b − 1| in whole bps (floor); b > 0. */
export function divergenceBps(aWad: bigint, bWad: bigint): number {
  if (bWad <= 0n) return Number.POSITIVE_INFINITY;
  return Number((abs(aWad - bWad) * 10_000n) / bWad);
}

/**
 * Funding-aware target Δ* (off unless configured). If both venues' funding APRs have the same sign and the spread
 * |APR_m − APR_p| ≥ threshold, keep a small residual on the side that RECEIVES funding on both venues: rates > 0 ⇒ longs
 * pay ⇒ net short earns. > VERIFY MFI.md §2 (b): Perpl's sign convention is not proven from a settlement yet; the bias
 * stays off by default until it is.
 */
export function fundingTargetWad(cfg: HedgeConfig, rates: HedgeInputs["rates"]): bigint {
  const b = cfg.fundingBias;
  if (!b || !rates) return 0n;
  const sm = sign(rates.meridianAprWad);
  if (sm === 0n || sm !== sign(rates.perplAprWad)) return 0n;
  if (abs(rates.meridianAprWad - rates.perplAprWad) < b.minSpreadAprWad) return 0n;
  return -sm * b.residualWad;
}

/** Halting conditions (kill switch / circuit breaker): any one stops hedging and cancels resting Perpl orders. */
export function haltReasons(cfg: HedgeConfig, i: HedgeInputs): string[] {
  const r: string[] = [];
  if (!cfg.enabled) r.push("PERPL_HEDGE=0");
  if (!i.perplReady && i.perplDataAgeMs > cfg.maxDataAgeMs) r.push("perpl trading connection down");
  if (i.perplDataAgeMs > cfg.maxDataAgeMs) r.push(`perpl data ${Number.isFinite(i.perplDataAgeMs) ? Math.round(i.perplDataAgeMs) : "∞"} ms old`);
  if (i.fw !== true) r.push(i.fw === false ? "order forwarding (fw) is off: enable One-Click Trading" : "account not seen yet");
  if (i.frozen === true) r.push("perpl account frozen");
  if (i.availableCollateral === undefined || i.availableCollateral < cfg.minCollateral) r.push(`collateral ${i.availableCollateral ?? "?"} < min ${cfg.minCollateral}`);
  if (i.consecutiveRejects >= cfg.maxConsecutiveRejects) r.push(`${i.consecutiveRejects} rejections in a row`);
  if (!i.marketOpen) r.push("perpl market closed");
  return [...new Set(r)];
}

export function decideHedge(cfg: HedgeConfig, i: HedgeInputs): HedgeDecision {
  const halt = haltReasons(cfg, i);
  if (halt.length) return { action: "halt", reasons: halt };

  const perplPosWad = scaledSizeToWad(i.perplPosScaled, i.sizeDecimals);
  const deltaWad = i.merPosWad + perplPosWad;
  const targetWad = fundingTargetWad(cfg, i.rates);
  const hold = (reason: string): HedgeDecision => ({ action: "hold", reason, deltaWad, targetWad });

  if (i.inFlight) return hold("previous hedge awaiting its outcome");
  if (i.lastHedgeMs !== undefined && i.nowMs - i.lastHedgeMs < cfg.cooldownMs) return hold("cool-down");
  const err = deltaWad - targetWad;
  const band = (cfg.maxInventoryWad * BigInt(cfg.bandBps)) / 10_000n;
  if (abs(err) <= band) return hold("inside band");
  if (!(i.perplBid > 0 && i.perplAsk > i.perplBid)) return hold("perpl book one-sided or crossed");

  const midScaled2 = BigInt(i.perplBid) + BigInt(i.perplAsk); // 2 × mid, scaled
  const midWad = (scaledPriceToWad(1, i.priceDecimals) * midScaled2) / 2n;
  const div = divergenceBps(midWad, i.meridianIndexWad);
  if (div > cfg.maxDivergenceBps) return hold(`venue prices diverge ${div} bps > ${cfg.maxDivergenceBps}`);

  // trade on Perpl = −(err − sign(err)·residual): reduce |err| to the residual, never past it
  const residual = cfg.residualWad < abs(err) ? cfg.residualWad : abs(err);
  const want = -(err - sign(err) * residual); // signed MON WAD to trade on Perpl (+ buy)
  let sizeWad = abs(want) < cfg.maxHedgePerOrderWad ? abs(want) : cfg.maxHedgePerOrderWad;
  const buy = want > 0n;

  // exposure cap: |perplPos after| × mid ≤ maxPerplNotional (only binds when the order grows |perplPos|)
  const after = perplPosWad + (buy ? sizeWad : -sizeWad);
  if (abs(after) > abs(perplPosWad)) {
    const capPos = (cfg.maxPerplNotionalWad * WAD) / midWad; // floor
    if (abs(after) > capPos) {
      const room = capPos > abs(perplPosWad) ? capPos - abs(perplPosWad) : 0n;
      // growing |perplPos| only happens past flat on the order's own side: reducing first is always allowed
      const reducing = sign(perplPosWad) !== 0n && sign(perplPosWad) !== (buy ? 1n : -1n) ? abs(perplPosWad) : 0n;
      sizeWad = reducing + room < sizeWad ? reducing + room : sizeWad;
    }
  }

  // closing the opposite position first: reduce-only Close*, clamped to the position (websocket.md: never inverts)
  let orderType: OrderTypeT;
  if (buy && perplPosWad < 0n) {
    orderType = OrderType.CloseShort;
    if (sizeWad > -perplPosWad) sizeWad = -perplPosWad;
  } else if (!buy && perplPosWad > 0n) {
    orderType = OrderType.CloseLong;
    if (sizeWad > perplPosWad) sizeWad = perplPosWad;
  } else orderType = buy ? OrderType.OpenLong : OrderType.OpenShort;

  const size = wadToScaledSize(sizeWad, i.sizeDecimals); // toward zero: never over-hedge
  if (size <= 0n) return hold("hedge size rounds to zero (size_decimals) or cap reached");

  // IOC limit at mid ± slippage, rounded toward mid (never worse than the slippage bound)
  const slip = BigInt(cfg.slippageBps);
  const price = buy ? (midScaled2 * (10_000n + slip)) / 20_000n : (midScaled2 * (10_000n - slip) + 19_999n) / 20_000n;
  if (price <= 0n) return hold("limit price rounds to zero");
  const tradedWad = scaledSizeToWad(Number(size), i.sizeDecimals);
  return {
    action: "hedge",
    order: { side: buy ? "buy" : "sell", orderType, size: Number(size), price: Number(price), flags: 4, leverage: cfg.leverage },
    deltaWad,
    targetWad,
    deltaAfterWad: deltaWad + (buy ? tradedWad : -tradedWad),
    divergenceBps: div,
  };
}

/**
 * Position the A–S inventory term uses (as.ts `q = position / maxInventory`): Meridian-only with the hedge off — byte for
 * byte the old behaviour — and the NET delta when the hedge is on and its Perpl state is fresh (a hedge we can't see
 * is not counted).
 */
export function quoteInventoryWad(merPosWad: bigint, perpl: { posScaled: number; sizeDecimals: number; fresh: boolean } | undefined): bigint {
  if (!perpl || !perpl.fresh) return merPosWad;
  return merPosWad + scaledSizeToWad(perpl.posScaled, perpl.sizeDecimals);
}
