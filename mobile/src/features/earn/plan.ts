// The Earn quote, pure (run per block, input debounced). "Earn X % APR on AUSD" = core planBasis (short the venue whose
// longs pay more, long the other, EQUAL MON size on both venues' steps, net of the round-trip taker fees + the book
// slippage over the 30 d horizon), sized from the AUSD the user commits, and turned into an executable core
// BasisExecPlan: Perpl leg side, both limits (walked on each live book ± slippage, snapped to the price step against
// the user: buy ↑, sell ↓), the collateral each venue must hold (margin + fee, owed ⇒ up) and what blocks the trade.
//
// Sizing: the amount A is split evenly, A/2 per venue, at EARN_LEVERAGE× per leg, so notional per leg = A·L/2 minus
// room for the taker fee (margin + fee ≤ A/2), divided by the highest price the buy leg could pay (best ask ·
// (1 + slippage)), floored to lcm(steps). At L = 2 the notional per leg equals A, so the APR on AUSD = the pair's net
// APR. Funding sign (core README §Open, measured N4): positive ⇒ longs pay.
import { formatFixed, initialMarginWad, swapLockNeedWad, type SwapObs, type SwapParamsLite } from "@meridian/core/meridian";
import { limitFrom, opposite, type BasisExecPlan, type CloseExecPlan, type OrderSide } from "@meridian/core/exec";
import { lockQuote, planBasis, quoteVenue, walkBook, type BasisPlan, type BookLevel, type Venue, type VenueQuote } from "@meridian/core/route";
import { abs, divCeil, divFloor, WAD } from "@meridian/core/util";

/** Leverage per leg. 2× ⇒ the notional on each venue equals the AUSD committed, so APR on AUSD = the pair's net APR. */
export const EARN_LEVERAGE = 2n;
/** Worst price vs the book for both open legs; the unwind uses the same, its retry 2× (core exec/basis). */
export const EARN_SLIPPAGE_BPS = 100n;
export const EARN_HORIZON_DAYS = 30n;

const TOKEN = 10n ** 12n; // AUSD 6 dp ↔ WAD (CONTRIBUTING §2)
const ceilToToken = (wad: bigint) => divCeil(wad, TOKEN) * TOKEN;
const floorTo = (x: bigint, step: bigint) => (x / step) * step;

export type EarnVenueInput = {
  /** funding APR of real time (WAD, signed; + ⇒ longs pay) */
  aprWad: bigint | undefined;
  takerFeeWad: bigint | undefined;
  stepWad: bigint | undefined;
  priceStepWad: bigint | undefined;
  priceDp: number;
  bids: readonly BookLevel[] | undefined;
  asks: readonly BookLevel[] | undefined;
  markWad: bigint | undefined;
  /** free collateral on the venue (WAD); undefined = not read yet */
  freeWad: bigint | undefined;
  /** the wallet token that funds this venue (WAD) */
  walletWad: bigint | undefined;
  /** tradeable now (Perpl: onboarding READY) */
  ready: boolean;
  /** Meridian riskParams.imr (initial margin rule) */
  imrWad?: bigint;
  /** the venue's max leverage (Meridian 1/imr, Perpl init hdths / 100) */
  maxLeverage?: number;
};

export type EarnInput = { amountWad: bigint | undefined; meridian: EarnVenueInput; perpl: EarnVenueInput; slippageBps?: bigint; lock?: EarnLockInput };

// ── Lock (MOBILE_PLAN N6 "Lock 30 d", MATH_SPEC §6): fix the Meridian leg's floating funding on the funding-swap book ──

/** Worst price vs the swap book (price = 1 + APR): 20 bps of p ≈ 0.2 APR points. */
export const LOCK_SLIPPAGE_BPS = 20n;

export type EarnLockInput = {
  /** the toggle */
  on: boolean;
  bids: readonly BookLevel[] | undefined;
  asks: readonly BookLevel[] | undefined;
  tickSizeWad: bigint | undefined;
  lotSizeWad: bigint | undefined;
  params: SwapParamsLite | undefined;
  /** markApr, index (ClearingHouse.indexPrice), cap APR, τ (FundingSwapMarket._observe inputs) */
  obs: SwapObs | undefined;
  matured: boolean | undefined;
  /** maturity timestamp (s) for "until <date>" */
  maturity: bigint | undefined;
  /** the wallet's swap account (settled collateral, size, K) */
  account: { collateralWad: bigint; sizeWad: bigint; kWad: bigint } | undefined;
};

export type EarnLock =
  | { available: false; reason: string }
  | {
      available: true;
      swapSide: OrderSide;
      /** swap size that fills (≤ the hedge, whole swap lots); the rest of the hedge keeps floating */
      sizeWad: bigint;
      unlockedWad: bigint;
      /** fixed APR after the taker fee: received (sell, ↓) or paid (buy, ↑) */
      netFixedAprWad: bigint;
      limitPriceWad: bigint;
      lotWad: bigint;
      /** collateral to add on the swap market (whole AUSD units, ↑) */
      depositWad: bigint;
      maturity: bigint | undefined;
    };

/** The Lock quote for a hedge of `sizeWad` whose Meridian perp leg is `meridianSide` (core route/lock + swapLockNeedWad). */
export function quoteLock(l: EarnLockInput, meridianSide: OrderSide, sizeWad: bigint, slippageBps = LOCK_SLIPPAGE_BPS): EarnLock {
  if (!l.bids || !l.asks || !l.tickSizeWad || !l.lotSizeWad || !l.params || !l.obs || l.matured === undefined) return { available: false, reason: "Reading the fixed-rate book…" };
  if (l.matured || l.obs.tauSec === 0n) return { available: false, reason: "This fixed-rate swap has matured; Lock opens again with the next one." };
  if (sizeWad < l.lotSizeWad) return { available: false, reason: `Lock needs at least ${formatFixed(l.lotSizeWad, 18, 0)} MON on each side (one swap lot).` };
  const q = lockQuote({ perpSide: meridianSide === "buy" ? "long" : "short", perpSizeWad: sizeWad, bids: l.bids, asks: l.asks, swapLotWad: l.lotSizeWad, takerFeeAprWad: l.params.takerFeeApr });
  if (!q.available || q.netFixedAprWad === undefined) return { available: false, reason: "No fixed-rate quotes on the swap book right now." };
  const w = walkBook(q.swapSide === "sell" ? l.bids : l.asks, q.sizeWad, q.swapSide, { stepWad: l.lotSizeWad });
  const worst = w.worstPriceWad!;
  const limitPriceWad = snap(limitFrom(worst, q.swapSide, slippageBps), l.tickSizeWad, q.swapSide);
  const acc = l.account ?? { collateralWad: 0n, sizeWad: 0n, kWad: 0n };
  const need = swapLockNeedWad({ q0: acc.sizeWad, k0: acc.kWad, collateralWad: acc.collateralWad, dq: q.swapSide === "buy" ? q.sizeWad : -q.sizeWad, worstAprWad: limitPriceWad - WAD, obs: l.obs, params: l.params });
  return { available: true, swapSide: q.swapSide, sizeWad: q.sizeWad, unlockedWad: q.unlockedWad, netFixedAprWad: q.netFixedAprWad, limitPriceWad, lotWad: l.lotSizeWad, depositWad: need > 0n ? ceilToToken(need) : 0n, maturity: l.maturity };
}

export type EarnBlocker = { kind: "onboard" } | { kind: "fund"; venue: Venue; shortWad: bigint } | { kind: "leverage"; venue: Venue; max: number };

export type EarnStatus = "loading" | "empty" | "no-edge" | "too-small" | "no-liquidity" | "ok";

export type EarnLeg = { venue: Venue; side: OrderSide; quote: VenueQuote; limitPriceWad: bigint; feeWad: bigint; marginWad: bigint; needWad: bigint; depositWad: bigint };

export type EarnQuote = {
  status: EarnStatus;
  /** APR on the AUSD committed, net of fees + slippage (rounds down: earned); the hero */
  aprOnAusdWad: bigint | undefined;
  grossAprWad: bigint | undefined;
  feeDragAprWad: bigint | undefined;
  /** ≈ per day at the current gap (rounds down) */
  perDayWad: bigint | undefined;
  shortVenue: Venue | undefined;
  sizeWad: bigint;
  stepWad: bigint | undefined;
  plan: BasisPlan | undefined;
  legs: { perpl: EarnLeg; meridian: EarnLeg } | undefined;
  blockers: EarnBlocker[];
  /** what core's executor runs (status ok, no blockers) */
  exec: BasisExecPlan | undefined;
  /** the Lock quote for this hedge (shown whether or not the toggle is on) */
  lock?: EarnLock;
};

type Priced = EarnVenueInput & { aprWad: bigint; takerFeeWad: bigint; stepWad: bigint; priceStepWad: bigint; bids: readonly BookLevel[]; asks: readonly BookLevel[] };
const priced = (v: EarnVenueInput): v is Priced => v.aprWad !== undefined && v.takerFeeWad !== undefined && v.stepWad !== undefined && v.priceStepWad !== undefined && v.stepWad > 0n && v.priceStepWad > 0n && v.bids !== undefined && v.asks !== undefined;

const EMPTY: Omit<EarnQuote, "status"> = { aprOnAusdWad: undefined, grossAprWad: undefined, feeDragAprWad: undefined, perDayWad: undefined, shortVenue: undefined, sizeWad: 0n, stepWad: undefined, plan: undefined, legs: undefined, blockers: [], exec: undefined };

/** entry + exit slippage as a WAD fraction of notional: 2 · |avg − mark| / mark per leg, rounds up (a cost) */
function slippageFraction(q: VenueQuote, markWad: bigint | undefined): bigint {
  const avg = q.walk.avgPriceWad;
  if (avg === undefined || !markWad || markWad <= 0n) return 0n;
  return divCeil(2n * abs(avg - markWad) * WAD, markWad);
}

const snap = (raw: bigint, step: bigint, side: OrderSide) => (side === "buy" ? divCeil(raw, step) * step : divFloor(raw, step) * step);

function leg(v: Priced, venue: Venue, side: OrderSide, sizeWad: bigint, slippageBps: bigint): EarnLeg {
  const quote = quoteVenue({ venue, levels: side === "buy" ? v.asks : v.bids, takerFeeWad: v.takerFeeWad, stepWad: v.stepWad }, side, sizeWad);
  const worst = quote.walk.worstPriceWad ?? (side === "buy" ? v.asks[0]?.priceWad : v.bids[0]?.priceWad) ?? 0n;
  const limitPriceWad = worst > 0n ? snap(limitFrom(worst, side, slippageBps), v.priceStepWad, side) : 0n;
  let marginWad = divCeil(quote.walk.notionalWad, EARN_LEVERAGE); // committed, rounds up
  if (v.imrWad !== undefined && quote.walk.avgPriceWad !== undefined) {
    const im = initialMarginWad(sizeWad, quote.walk.avgPriceWad, v.imrWad);
    if (im > marginWad) marginWad = im;
  }
  const needWad = marginWad + quote.feeWad;
  const free = v.freeWad ?? 0n;
  const depositWad = needWad > free ? ceilToToken(needWad - free) : 0n; // owed ⇒ whole token units, up
  return { venue, side, quote, limitPriceWad, feeWad: quote.feeWad, marginWad, needWad, depositWad };
}

export function quoteEarn(i: EarnInput): EarnQuote {
  const slip = i.slippageBps ?? EARN_SLIPPAGE_BPS;
  const m = i.meridian;
  const p = i.perpl;
  if (!priced(m) || !priced(p)) return { ...EMPTY, status: "loading" };
  const tops = [m.asks[0]?.priceWad, p.asks[0]?.priceWad].filter((x): x is bigint => x !== undefined && x > 0n);
  const mark = p.markWad ?? m.markWad ?? tops[0];
  if (tops.length < 2 || !m.bids[0] || !p.bids[0] || mark === undefined) {
    // the hero still shows the gross gap; nothing is executable without both books
    return { ...EMPTY, status: "no-liquidity", grossAprWad: abs(p.aprWad - m.aprWad) };
  }
  const venueIn = (v: Priced, slippageWad = 0n) => ({ aprWad: v.aprWad, takerFeeWad: v.takerFeeWad, stepWad: v.stepWad, slippageWad });
  // the rate (hero) at one common step: fee drag doesn't depend on size
  const ref = planBasis({ meridian: venueIn(m), perpl: venueIn(p), sizeWad: 0n, markWad: mark, horizonDays: EARN_HORIZON_DAYS });
  const base = { ...EMPTY, grossAprWad: ref.grossAprWad, feeDragAprWad: ref.feeDragAprWad, aprOnAusdWad: ref.netAprWad, shortVenue: ref.shortVenue, stepWad: ref.stepWad };

  if (i.amountWad === undefined || i.amountWad <= 0n) return { ...base, status: ref.netAprWad > 0n ? "empty" : "no-edge" };

  // size: A/2 per venue at L×, leaving room for the larger taker fee; priced at the highest price the buy leg could pay
  const budget = i.amountWad / 2n;
  const feeMax = m.takerFeeWad > p.takerFeeWad ? m.takerFeeWad : p.takerFeeWad;
  const notional = divFloor(budget * EARN_LEVERAGE * WAD, WAD + EARN_LEVERAGE * feeMax); // rounds down
  const refPx = limitFrom(tops.reduce((a, b) => (b > a ? b : a)), "buy", slip);
  const want = divFloor(notional * WAD, refPx);
  const sized = planBasis({ meridian: venueIn(m), perpl: venueIn(p), sizeWad: want, markWad: mark, horizonDays: EARN_HORIZON_DAYS });
  if (sized.sizeWad === 0n) return { ...base, status: "too-small", plan: sized };

  const perplSide: OrderSide = sized.shortVenue === "perpl" ? "sell" : "buy";
  const meridianSide: OrderSide = perplSide === "buy" ? "sell" : "buy";
  const pl = leg(p, "perpl", perplSide, sized.sizeWad, slip);
  const ml = leg(m, "meridian", meridianSide, sized.sizeWad, slip);
  // net of the real book slippage on both legs (entry + exit), at this size
  const slippageWad = slippageFraction(pl.quote, p.markWad ?? mark) + slippageFraction(ml.quote, m.markWad ?? mark);
  const plan = planBasis({ meridian: venueIn(m), perpl: venueIn(p, slippageWad), sizeWad: sized.sizeWad, markWad: mark, horizonDays: EARN_HORIZON_DAYS });
  // APR on the AUSD committed: net · notional / amount, rounds down (earned)
  const aprOnAusdWad = plan.netAprWad > 0n ? divFloor(plan.netAprWad * plan.notionalWad, i.amountWad) : plan.netAprWad;
  const out = { ...base, grossAprWad: plan.grossAprWad, feeDragAprWad: plan.feeDragAprWad, aprOnAusdWad, perDayWad: plan.estPerDayWad, sizeWad: plan.sizeWad, plan, legs: { perpl: pl, meridian: ml } };

  if (!pl.quote.eligible || !ml.quote.eligible) return { ...out, status: "no-liquidity" };
  if (!plan.edge) return { ...out, status: "no-edge" };

  const blockers: EarnBlocker[] = [];
  if (!p.ready) blockers.push({ kind: "onboard" });
  for (const [venue, v] of [["meridian", m], ["perpl", p]] as const) {
    if (v.maxLeverage !== undefined && Number(EARN_LEVERAGE) > v.maxLeverage + 1e-9) blockers.push({ kind: "leverage", venue, max: v.maxLeverage });
  }
  const lock = i.lock ? quoteLock(i.lock, meridianSide, plan.sizeWad) : undefined;
  const locking = i.lock?.on === true && lock?.available === true ? lock : undefined;
  for (const l of [ml, pl]) {
    const wallet = (l.venue === "perpl" ? p.walletWad : m.walletWad) ?? 0n;
    // the swap market is funded with Meridian's AUSD too
    const need = l.depositWad + (l.venue === "meridian" && locking ? locking.depositWad : 0n);
    if (need > wallet) blockers.push({ kind: "fund", venue: l.venue, shortWad: need - wallet });
  }
  const exec: BasisExecPlan = {
    perplSide,
    sizeWad: plan.sizeWad,
    perplLimitPriceWad: pl.limitPriceWad,
    meridianLimitPriceWad: ml.limitPriceWad,
    meridianLotWad: m.stepWad,
    perplStepWad: p.stepWad,
    perplCollateralWad: pl.needWad,
    meridianCollateralWad: ml.needWad,
    unwindSlippageBps: slip,
    ...(locking ? { lock: { side: locking.swapSide, maxSizeWad: locking.sizeWad, limitPriceWad: locking.limitPriceWad, lotWad: locking.lotWad } } : {}),
  };
  return { ...out, status: "ok", blockers, exec: blockers.length === 0 ? exec : undefined, ...(lock ? { lock } : {}) };
}

/** Spendable for Earn: the binding venue ×2 (the amount is split evenly), each = free on the venue + its wallet token. */
export function earnAvailableWad(m: Pick<EarnVenueInput, "freeWad" | "walletWad">, p: Pick<EarnVenueInput, "freeWad" | "walletWad">): bigint | undefined {
  if (m.walletWad === undefined && m.freeWad === undefined) return undefined;
  if (p.walletWad === undefined && p.freeWad === undefined) return undefined;
  const a = (m.freeWad ?? 0n) + (m.walletWad ?? 0n);
  const b = (p.freeWad ?? 0n) + (p.walletWad ?? 0n);
  return 2n * (a < b ? a : b);
}

// ── close ──

export type EarnCloseInput = {
  /** the hedged pair Earn opened (record.ts EarnPosition) */
  perplSide: OrderSide | undefined;
  sizeWad: bigint;
  /** live positions: Meridian signed size (+ long), Perpl side + size */
  meridianSizeWad: bigint | undefined;
  perpl: { side: "Long" | "Short"; sizeWad: bigint } | undefined;
  meridian: Pick<EarnVenueInput, "bids" | "asks" | "takerFeeWad" | "stepWad" | "priceStepWad">;
  perplBook: Pick<EarnVenueInput, "bids" | "asks" | "stepWad">;
  slippageBps?: bigint;
};

export type EarnClosePlan = { ok: true; plan: CloseExecPlan; sizeWad: bigint } | { ok: false; error: string };

/**
 * Closing the pair (core exec/close): Meridian reduce-only first, then Perpl reduce-only for exactly what closed. Size =
 * the Earn pair, capped by what each venue really holds on the expected side (a manual trade in between may have
 * changed it), floored to both steps. Meridian limit = its book walked at that size ± slippage, snapped against the
 * user; Perpl reference = the side its close hits (buy ⇒ best ask, sell ⇒ best bid).
 */
export function planEarnClose(i: EarnCloseInput): EarnClosePlan {
  if (!i.perplSide || i.sizeWad <= 0n) return { ok: false, error: "No Earn position to close." };
  const slip = i.slippageBps ?? EARN_SLIPPAGE_BPS;
  const m = i.meridian;
  if (!m.bids || !m.asks || m.takerFeeWad === undefined || !m.stepWad || !m.priceStepWad || !i.perplBook.stepWad || !i.perplBook.bids || !i.perplBook.asks) return { ok: false, error: "Both books are still loading. Try again in a moment." };
  const perplLong = i.perplSide === "buy";
  // what each venue holds on the pair's side
  const mHeld = i.meridianSizeWad === undefined ? 0n : perplLong ? (i.meridianSizeWad < 0n ? -i.meridianSizeWad : 0n) : i.meridianSizeWad > 0n ? i.meridianSizeWad : 0n;
  const pHeld = i.perpl && (i.perpl.side === "Long") === perplLong ? i.perpl.sizeWad : 0n;
  let size = i.sizeWad;
  if (mHeld < size) size = mHeld;
  if (pHeld < size) size = pHeld;
  const step = lcmOf(m.stepWad, i.perplBook.stepWad);
  size = floorTo(size, step);
  if (size === 0n) return { ok: false, error: "Your Earn legs are no longer open on both venues. Close what's left from the Trade tab." };
  const meridianSide: OrderSide = i.perplSide; // Meridian holds the opposite: closing it trades the Perpl leg's side
  const perplSide: OrderSide = opposite(i.perplSide);
  const mq = quoteVenue({ venue: "meridian", levels: meridianSide === "buy" ? m.asks : m.bids, takerFeeWad: m.takerFeeWad, stepWad: m.stepWad }, meridianSide, size);
  const worst = mq.walk.worstPriceWad;
  if (!mq.eligible || worst === undefined) return { ok: false, error: "Meridian's book can't take the whole close right now. Try again in a moment." };
  const perplRef = perplSide === "buy" ? i.perplBook.asks[0]?.priceWad : i.perplBook.bids[0]?.priceWad;
  if (perplRef === undefined) return { ok: false, error: `No ${perplSide === "buy" ? "asks" : "bids"} on Perpl right now, so the pair can't be closed at a fair price.` };
  return {
    ok: true,
    sizeWad: size,
    plan: {
      meridianSide,
      perplSide,
      sizeWad: size,
      meridianLimitPriceWad: snap(limitFrom(worst, meridianSide, slip), m.priceStepWad, meridianSide),
      perplRefPriceWad: perplRef,
      perplSlippageBps: slip,
      perplStepWad: i.perplBook.stepWad,
    },
  };
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const lcmOf = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;

/** Close a Lock before the pair: the whole swap position, reduce-only, at the swap book ± LOCK_SLIPPAGE (snapped against the user). */
export function planSwapClose(s: { sizeWad: bigint; bids: readonly BookLevel[] | undefined; asks: readonly BookLevel[] | undefined; tickSizeWad: bigint | undefined; lotSizeWad: bigint | undefined }): { ok: true; order: { side: OrderSide; sizeWad: bigint; limitPriceWad: bigint } } | { ok: false; error: string } {
  if (!s.bids || !s.asks || !s.tickSizeWad || !s.lotSizeWad) return { ok: false, error: "The fixed-rate book is still loading. Try again in a moment." };
  const side: OrderSide = s.sizeWad > 0n ? "sell" : "buy";
  const size = s.sizeWad > 0n ? s.sizeWad : -s.sizeWad;
  const w = walkBook(side === "sell" ? s.bids : s.asks, size, side, { stepWad: s.lotSizeWad });
  if (w.worstPriceWad === undefined || w.residualWad > 0n) return { ok: false, error: "The fixed-rate book can't take your whole lock right now, so nothing was closed. Try again in a moment." };
  return { ok: true, order: { side, sizeWad: size, limitPriceWad: snap(limitFrom(w.worstPriceWad, side, LOCK_SLIPPAGE_BPS), s.tickSizeWad, side) } };
}
