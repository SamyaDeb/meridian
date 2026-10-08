// Perpl position risk with Perpl's own margin rule. Ported from meridian-k5/risk/src/perpl.ts (rates-risk @ 1edb15f); the
// APR / fee unit helpers live in ../perpl/units (perplPct100kToAprWad, perplRateToAprWad, perplFeeWad).
// Perpl position risk, computed with Perpl's own margin rule. Sources (read 8 Oct 2026):
//  - Perpl SDK (MIT) github.com/PerplFoundation/dex-sdk @ 01b9910, crates/sdk/src/state/position.rs:
//    `liquidation_price = entry + s·(MMR − deposit − premium_pnl) / size`, `bankruptcy_price = entry − s·(deposit +
//    premium_pnl) / size`, `MMR = entry·size / maintenance_margin`, `effective_entry_price` (Q16 residue), and
//    state/perpetual.rs: margins are in hundredths (`maintenance_margin = maintMarginFracHdths / 100`, a divisor like
//    leverage: MON mainnet 2000 ⇒ 20 ⇒ 5 % of notional, testnet 500 ⇒ 5 ⇒ 20 %).
//  - Perpl docs github.com/PerplFoundation/perpl-docs @ fbbe822, docs/exchange/margin.md ("0 < FMV ≤ MMR" ⇒ liquidation,
//    "FMV ≤ 0" ⇒ ADL) and docs/exchange/liquidation/README.md (the same liquidation-price formula).
//  - Exchange views (indexer/abis/PerplExchange.json): getPositionV2 → depositCNS, pricePNS, priceResiduePNSQ16, lotLNS,
//    deltaPnlCNS, premiumPnlCNS, markPricePNS; getMarginFractions(perpId, 0) → perpMaintMarginFracHdths.
// Units (indexer/PERPL_EVENTS.md "Units"): *PNS = int·10^-priceDecimals, *LNS = int·10^-lotDecimals, *CNS = AUSD 6 dp.
// Rounding: against the trader, in favour of solvency (CONTRIBUTING.md §2): the liquidation price rounds toward the mark
// (long up, short down), margin requirements up, equity and amounts paid to the trader down, amounts owed up.
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, WAD, abs, divCeil, divFloor, divTrunc, pow10 } from "../util/fixed";

const AUSD_TO_WAD = 10n ** 12n; // CNS = AUSD 6 dp (deployments/perpl.json collateralDecimals)

export const Q16 = 65_536n;
const HDTHS = 100n;
const BPS = 10_000n;

export type PerplSide = "Long" | "Short";
export const perplSide = (positionType: number): PerplSide => {
  if (positionType === 0) return "Long"; // PERPL_EVENTS.md: positionType 0 = Long, 1 = Short
  if (positionType === 1) return "Short";
  throw new RangeError(`unknown Perpl positionType ${positionType}`);
};
const sign = (s: PerplSide): bigint => (s === "Long" ? 1n : -1n);

/** getPositionV2(perpId, accountId).positionInfo, the fields the risk view needs (raw exchange integers). */
export type PerplPositionRaw = {
  positionType: number;
  depositCNS: bigint;
  pricePNS: bigint;
  priceResiduePNSQ16: bigint;
  lotLNS: bigint;
  deltaPnlCNS: bigint;
  premiumPnlCNS: bigint;
};

/** Market parameters from the exchange views (getPerpetualInfoV2 decimals, getMarginFractions(perpId, 0)). */
export type PerplMarketParams = { priceDecimals: number; lotDecimals: number; maintMarginHdths: bigint };

/**
 * Perpl SDK `Position::effective_entry_price`, as an integer in PNS·2^16: the contract stores the entry rounded (long:
 * ceil, short: floor) plus a 16-bit residue. Long: (p − 1)·Q + r if r > 0; short: p·Q + r. Exact.
 */
export function effectiveEntryQ16(p: Pick<PerplPositionRaw, "positionType" | "pricePNS" | "priceResiduePNSQ16">): bigint {
  const r = p.priceResiduePNSQ16;
  if (r < 0n || r >= Q16) throw new RangeError("residue out of range");
  if (r === 0n) return p.pricePNS * Q16;
  const base = perplSide(p.positionType) === "Long" && p.pricePNS >= 1n ? p.pricePNS - 1n : p.pricePNS;
  return base * Q16 + r;
}

export type PerplPositionRisk = {
  side: PerplSide;
  lots: bigint;
  sizeWad: bigint;
  /** effective entry (the residue included), rounded toward zero to WAD for display */
  entryWad: bigint;
  markWad: bigint;
  depositWad: bigint;
  /** the exchange's own unrealized PnL at its mark: deltaPnl (price) + premiumPnl (funding), quote WAD */
  unrealizedPnlWad: bigint;
  deltaPnlWad: bigint;
  premiumPnlWad: bigint;
  /** deposit + unrealized PnL (Perpl's FMV at the mark) */
  equityWad: bigint;
  notionalAtMarkWad: bigint;
  /** MMR = entry·size / (maintMarginHdths / 100), rounds up */
  mmrWad: bigint;
  /** maintenance fraction of notional, WAD (MON mainnet 0.05, testnet 0.2) */
  maintFractionWad: bigint;
  /** liquidation price, rounds toward the mark (long up, short down); 0 = a long that can't be liquidated above 0 */
  liqPriceWad: bigint;
  bankruptcyPriceWad: bigint;
  /** adverse mark move to the liquidation price, bps of the mark, rounds down; 0 = at or past it */
  liqDistanceBps: bigint;
  /** entry notional / deposit, ×1e18, rounds up */
  leverageWad: bigint;
};

/**
 * One Perpl position's risk at the exchange's mark (Perpl SDK position.rs, docs liquidation/README.md):
 * `P_liq = E + s·(MMR − D − F)/L` with `MMR = E·L·100/m` ⇒ `P_liq = E·(m + s·100)/m − s·(D + F)/L`, one exact fraction
 * with a single rounding (toward the mark). E = effective entry, D = deposit, F = premium (funding) PnL, L = lots, s = ±1.
 */
export function perplPositionRisk(raw: PerplPositionRaw, markPNS: bigint, mkt: PerplMarketParams): PerplPositionRisk {
  if (raw.lotLNS <= 0n) throw new RangeError("no open position");
  if (mkt.maintMarginHdths <= 0n) throw new RangeError("maintenance margin must be positive");
  const side = perplSide(raw.positionType);
  const s = sign(side);
  const pd = pow10(mkt.priceDecimals);
  const sd = pow10(mkt.lotDecimals);
  const m = mkt.maintMarginHdths;
  const eQ = effectiveEntryQ16(raw);
  const L = raw.lotLNS;
  const DF = raw.depositCNS + raw.premiumPnlCNS; // CNS
  // liq·WAD = [eQ·(m + s·100)·1e6·L − s·DF·sd·Q·pd·m] · WAD / (Q·pd·m·1e6·L)
  const den = Q16 * pd * m * 1_000_000n * L;
  const num = (eQ * (m + s * HDTHS) * 1_000_000n * L - s * DF * sd * Q16 * pd * m) * WAD;
  const liqRaw = side === "Long" ? divCeil(num, den) : divFloor(num, den);
  const liqPriceWad = liqRaw < 0n ? 0n : liqRaw; // the SDK clamps at 0 too
  // bankruptcy·WAD = [eQ·1e6·L − s·DF·sd·Q·pd] · WAD / (Q·pd·1e6·L), same direction
  const bden = Q16 * pd * 1_000_000n * L;
  const bnum = (eQ * 1_000_000n * L - s * DF * sd * Q16 * pd) * WAD;
  const bRaw = side === "Long" ? divCeil(bnum, bden) : divFloor(bnum, bden);
  const entryWad = divTrunc(eQ * WAD, Q16 * pd);
  const markWad = divTrunc(markPNS * WAD, pd);
  const sizeWad = divTrunc(L * WAD, sd);
  // MMR = E·L·100/m (quote WAD), rounds up: eQ·L·100·WAD / (Q·pd·sd·m)
  const mmrWad = divCeil(eQ * L * HDTHS * WAD, Q16 * pd * sd * m);
  const depositWad = raw.depositCNS * AUSD_TO_WAD;
  const deltaPnlWad = raw.deltaPnlCNS * AUSD_TO_WAD;
  const premiumPnlWad = raw.premiumPnlCNS * AUSD_TO_WAD;
  const unrealizedPnlWad = deltaPnlWad + premiumPnlWad;
  const notionalAtMarkWad = divFloor(markPNS * L * WAD, pd * sd);
  const entryNotionalWad = divCeil(eQ * L * WAD, Q16 * pd * sd);
  const d = s * (markWad - liqPriceWad);
  return {
    side,
    lots: L,
    sizeWad,
    entryWad,
    markWad,
    depositWad,
    unrealizedPnlWad,
    deltaPnlWad,
    premiumPnlWad,
    equityWad: depositWad + unrealizedPnlWad,
    notionalAtMarkWad,
    mmrWad,
    maintFractionWad: divCeil(HDTHS * WAD, m),
    liqPriceWad,
    bankruptcyPriceWad: bRaw < 0n ? 0n : bRaw,
    liqDistanceBps: markWad <= 0n || d <= 0n ? 0n : divFloor(d * BPS, markWad),
    leverageWad: depositWad > 0n ? divCeil(entryNotionalWad * WAD, depositWad) : 0n,
  };
}

export type ShockOutcome = "ok" | "liquidated" | "bankrupt";
export type Shock = {
  /** signed move of the mark, bps (−1500 = −15 %) */
  moveBps: bigint;
  markWad: bigint;
  /** price + funding PnL at the shocked mark, quote WAD, rounds down */
  pnlWad: bigint;
  /** deposit + PnL (Perpl FMV), rounds down; this is the margin left */
  equityWad: bigint;
  /** equity as a share of notional at the shocked mark, bps, rounds down; liquidation once ≤ the maintenance fraction */
  marginRatioBps: bigint;
  /** docs margin.md: FMV ≤ 0 ⇒ ADL ("bankrupt"), 0 < FMV ≤ MMR ⇒ liquidated */
  outcome: ShockOutcome;
};

// the displayed shocked mark rounds against the trader: a long sees it lower, a short higher
const side0 = (side: PerplSide, num: bigint, den: bigint) => (side === "Long" ? divFloor(num, den) : divCeil(num, den));

/** Default shocks: ±5 / ±10 / ±15 % of the mark. */
export const SHOCKS_BPS: readonly bigint[] = [-1500n, -1000n, -500n, 500n, 1000n, 1500n];

/**
 * The position at a mark moved by `moveBps` (funding held at its current premium PnL): PnL = s·(M′ − E)·L + F, equity
 * D + PnL vs MMR. Rounds against the trader (the shocked mark itself rounds adversely, PnL and equity down).
 */
export function perplShock(raw: PerplPositionRaw, markPNS: bigint, mkt: PerplMarketParams, moveBps: bigint): Shock {
  const r = perplPositionRisk(raw, markPNS, mkt);
  const s = sign(r.side);
  const pd = pow10(mkt.priceDecimals);
  const sd = pow10(mkt.lotDecimals);
  const eQ = effectiveEntryQ16(raw);
  // shocked mark in PNS·Q16·BPS units, exact: markPNS·(BPS + move)·Q16
  const mQ = markPNS * (BPS + moveBps) * Q16;
  // price PnL (quote WAD) = s·(mQ − eQ·BPS)·L·WAD / (Q16·BPS·pd·sd), rounds down
  const pricePnlWad = divFloor(s * (mQ - eQ * BPS) * raw.lotLNS * WAD, Q16 * BPS * pd * sd);
  const pnlWad = pricePnlWad + r.premiumPnlWad;
  const equityWad = r.depositWad + pnlWad;
  const markWad = side0(r.side, markPNS * (BPS + moveBps) * WAD, BPS * pd);
  const notional = divCeil(markPNS * (BPS + moveBps) * raw.lotLNS * WAD, BPS * pd * sd);
  const outcome: ShockOutcome = equityWad <= 0n ? "bankrupt" : equityWad <= r.mmrWad ? "liquidated" : "ok";
  return { moveBps, markWad, pnlWad, equityWad, marginRatioBps: notional > 0n ? divFloor(equityWad * BPS, notional) : 0n, outcome };
}

/**
 * Funding cost per day of holding `sizeWad` at `markWad` under the annualized rate `aprWad` (positive ⇒ longs pay,
 * Perpl SDK `apply_funding_payment` and docs/MFI.md §1): s·APR·notional / 365. Positive = the position pays, negative =
 * it receives. Rounds toward +∞: what's owed rounds up, what's received rounds down in size.
 */
export function fundingCostPerDayWad(side: PerplSide, sizeWad: bigint, markWad: bigint, aprWad: bigint): bigint {
  return divCeil(sign(side) * aprWad * abs(sizeWad) * markWad * SECONDS_PER_DAY, WAD * WAD * SECONDS_PER_YEAR);
}
