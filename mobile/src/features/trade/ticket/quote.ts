// The ticket's live quote, pure (run per block, input debounced 150 ms). Everything goes through core: router v1
// (`route` / `quoteVenue`: effective price incl. taker fee, tie → Meridian), walkBook rounding (buyer ↑, seller ↓),
// liquidation previews (Meridian MATH_SPEC §3.2 via `meridianLiq`, Perpl's own rule via `perplPositionRisk`).
//
// Size: the AUSD amount is the margin the user commits; notional = amount · leverage; size = notional / reference, where
// the reference is the highest price the order could pay (buy: best ask · (1 + slippage); sell: best bid), so the
// margin never exceeds the amount. Sizes floor to the venue step (↓). Venues are compared at one size (floored to every
// venue's step), then the chosen venue is quoted at its own step. Limits: worst level ± slippage, rounded to the price
// step against the user (buy ↑, sell ↓). Amounts owed (fees, deposits) round up to whole token units.
import { formatFixed, initialMarginWad, liquidationPriceWad } from "@meridian/core/meridian";
import { perplPositionRisk, quoteVenue, route, type BookLevel, type Venue, type VenueBook, type VenueQuote } from "@meridian/core/route";
import { limitFrom } from "@meridian/core/exec";
import { divCeil, divFloor, WAD } from "@meridian/core/util";

export type MeridianLiqInput = { kind: "meridian"; mmrWad: bigint; imrWad: bigint; collateralWad: bigint; position: { sizeWad: bigint; entryWad: bigint } | undefined };
export type PerplLiqInput = { kind: "perpl"; maintHdths: bigint; priceDecimals: number; sizeDecimals: number; collateralDecimals: number };

export type VenueInput = {
  venue: Venue;
  label: string;
  /** the side a taker hits (asks for a long, bids for a short), best first; undefined = book not known yet */
  levels: readonly BookLevel[] | undefined;
  takerFeeWad: bigint | undefined;
  /** size step, base WAD (Meridian lotSize, Perpl 10^-sizeDecimals) */
  stepWad: bigint | undefined;
  /** price step, WAD (Meridian tickSize, Perpl 10^-priceDecimals) */
  priceStepWad: bigint | undefined;
  priceDp: number;
  /** Meridian 1 / imr; Perpl initMarginHdths / 100 (getMarginFractions) */
  maxLeverage: number | undefined;
  /** tradeable now (Perpl: onboarding READY); false ⇒ an "onboard" blocker, the price is still shown */
  ready: boolean;
  /** free collateral already on the venue (WAD) */
  freeCollateralWad: bigint | undefined;
  /** the wallet token that funds this venue (WAD) */
  walletWad: bigint | undefined;
  liq: MeridianLiqInput | PerplLiqInput | undefined;
};

export type Pick = "best" | Venue;
export type TicketInput = { side: "long" | "short"; amountWad: bigint | undefined; leverage: number; slippageBps: bigint; pick: Pick; venues: readonly VenueInput[] };

export type Blocker =
  | { kind: "onboard" }
  /** Perpl: move this much AUSD from the wallet to the Perpl account first */
  | { kind: "move"; amountWad: bigint }
  /** Meridian: deposit this much (permit) before the order, done in the same flow */
  | { kind: "deposit"; amountWad: bigint }
  /** the wallet can't cover what the venue needs */
  | { kind: "fund"; shortWad: bigint };

export type VenueLine = { venue: Venue; label: string; eligible: boolean; reason: string | undefined; effectivePriceWad: bigint | undefined; quote: VenueQuote | undefined };

export type Chosen = {
  venue: Venue;
  label: string;
  eligible: boolean;
  reason: string | undefined;
  sizeWad: bigint;
  stepWad: bigint;
  quote: VenueQuote;
  /** worst price the order accepts (sent as the limit) */
  limitPriceWad: bigint;
  priceDp: number;
  feeWad: bigint;
  /** collateral this trade commits: max(notional / leverage, initial margin), rounds up */
  marginWad: bigint;
  liqWad: bigint | undefined;
  blockers: Blocker[];
};

export type QuoteStatus = "empty" | "no-liquidity" | "too-small" | "no-venue" | "venue-unavailable" | "ok";
export type TicketQuote = { status: QuoteStatus; side: "long" | "short"; targetWad: bigint; best: Venue | undefined; lines: VenueLine[]; chosen: Chosen | undefined };

const TOKEN = 10n ** 12n; // AUSD 6 dp ↔ WAD (CONTRIBUTING §2, verified onchain)
const ceilToToken = (wad: bigint) => divCeil(wad, TOKEN) * TOKEN;
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const lcm = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;
const floorTo = (x: bigint, step: bigint) => (x / step) * step;

const REASON: Record<NonNullable<VenueQuote["reason"]>, (l: string) => string> = {
  unavailable: (l) => `${l} isn't available right now`,
  empty: () => "No liquidity right now",
  "size-step": (l) => `Below ${l}'s minimum size`,
  "insufficient-depth": (l) => `Not enough depth on ${l}`,
};

const priced = (v: VenueInput): v is VenueInput & { levels: readonly BookLevel[]; takerFeeWad: bigint; stepWad: bigint; priceStepWad: bigint } =>
  v.levels !== undefined && v.takerFeeWad !== undefined && v.stepWad !== undefined && v.priceStepWad !== undefined && v.stepWad > 0n && v.priceStepWad > 0n;

const book = (v: VenueInput & { levels: readonly BookLevel[]; takerFeeWad: bigint; stepWad: bigint }, levOk: boolean): VenueBook => ({ venue: v.venue, levels: v.levels, takerFeeWad: v.takerFeeWad, stepWad: v.stepWad, available: levOk });

const levOk = (v: VenueInput, lev: number) => v.maxLeverage === undefined || lev <= v.maxLeverage + 1e-9;

function lineOf(v: VenueInput, q: VenueQuote | undefined, lev: number): VenueLine {
  let reason: string | undefined;
  if (!levOk(v, lev)) reason = `Max ${formatLev(v.maxLeverage!)}× on ${v.label}`;
  else if (q && !q.eligible && q.reason) reason = REASON[q.reason](v.label);
  else if (!q) reason = "Reading the book…";
  return { venue: v.venue, label: v.label, eligible: reason === undefined && q !== undefined && q.eligible, reason, effectivePriceWad: q?.effectivePriceWad, quote: q };
}

const formatLev = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export function quoteTicket(i: TicketInput): TicketQuote {
  const side = i.side === "long" ? "buy" : "sell";
  const base = { side: i.side, targetWad: 0n, best: undefined, lines: [] as VenueLine[], chosen: undefined };
  if (i.amountWad === undefined || i.amountWad <= 0n) return { ...base, status: "empty" };
  const vs = i.venues.filter(priced);
  const tops = vs.map((v) => v.levels[0]?.priceWad).filter((p): p is bigint => p !== undefined && p > 0n);
  if (tops.length === 0) return { ...base, status: "no-liquidity", lines: i.venues.map((v) => lineOf(v, undefined, i.leverage)) };

  // reference: the highest price this order could pay ⇒ margin ≤ amount
  const ref = side === "buy" ? limitFrom(tops.reduce((a, b) => (b < a ? b : a)), "buy", i.slippageBps) : tops.reduce((a, b) => (b > a ? b : a));
  const notional = i.amountWad * BigInt(Math.round(i.leverage * 100)) / 100n;
  const target = divFloor(notional * WAD, ref); // size, rounds down

  const common = vs.reduce((s, v) => lcm(s, v.stepWad), 1n);
  const atCommon = floorTo(target, common);
  const books = vs.map((v) => book(v, levOk(v, i.leverage)));
  let quotes: VenueQuote[];
  let best: Venue | undefined;
  if (atCommon > 0n) {
    const r = route(side, atCommon, books);
    quotes = r.quotes;
    best = r.best;
  } else {
    // too small for one venue's step: each venue at its own step, the better eligible one wins
    quotes = books.map((b) => quoteVenue(b, side, floorTo(target, b.stepWad) > 0n ? floorTo(target, b.stepWad) : b.stepWad));
    const ok = quotes.filter((q, k) => q.eligible && floorTo(target, books[k]!.stepWad) > 0n && q.effectivePriceWad !== undefined);
    best = ok.sort((a, b) => (a.effectivePriceWad! === b.effectivePriceWad! ? (a.venue === "meridian" ? -1 : 1) : side === "buy" ? (a.effectivePriceWad! < b.effectivePriceWad! ? -1 : 1) : a.effectivePriceWad! > b.effectivePriceWad! ? -1 : 1))[0]?.venue;
  }
  const lines = i.venues.map((v) => lineOf(v, quotes.find((q) => q.venue === v.venue), i.leverage));
  if (vs.every((v) => floorTo(target, v.stepWad) === 0n)) return { ...base, status: "too-small", targetWad: target, lines };
  if (vs.every((v) => v.levels.length === 0)) return { ...base, status: "no-liquidity", targetWad: target, lines };

  const pickVenue = i.pick === "best" ? best : i.pick;
  const v = vs.find((x) => x.venue === pickVenue);
  if (!v) return { ...base, status: i.pick === "best" ? "no-venue" : "venue-unavailable", targetWad: target, best, lines };

  const size = floorTo(target, v.stepWad);
  const q = quoteVenue(book(v, levOk(v, i.leverage)), side, size);
  const line = lineOf(v, q, i.leverage);
  const chosen = finish(v, q, size, line, i);
  const status: QuoteStatus = chosen.eligible ? "ok" : i.pick === "best" ? "no-venue" : "venue-unavailable";
  return { status, side: i.side, targetWad: target, best, lines, chosen };
}

function finish(v: VenueInput & { stepWad: bigint; priceStepWad: bigint }, q: VenueQuote, size: bigint, line: VenueLine, i: TicketInput): Chosen {
  const buy = i.side === "long";
  const worst = q.walk.worstPriceWad ?? v.levels?.[0]?.priceWad ?? 0n;
  const rawLimit = worst > 0n ? limitFrom(worst, buy ? "buy" : "sell", i.slippageBps) : 0n;
  const limitPriceWad = buy ? divCeil(rawLimit, v.priceStepWad) * v.priceStepWad : divFloor(rawLimit, v.priceStepWad) * v.priceStepWad; // buy ↑, sell ↓
  const notionalAtFill = q.walk.notionalWad;
  const lev100 = BigInt(Math.round(i.leverage * 100));
  let marginWad = divCeil(notionalAtFill * 100n, lev100); // committed margin, rounds up
  if (v.liq?.kind === "meridian") {
    const im = q.walk.avgPriceWad !== undefined ? initialMarginWad(size, q.walk.avgPriceWad, v.liq.imrWad) : 0n;
    if (im > marginWad) marginWad = im;
  }
  const feeWad = q.feeWad;
  const blockers: Blocker[] = [];
  if (!v.ready) blockers.push({ kind: "onboard" });
  const need = marginWad + feeWad;
  const free = v.freeCollateralWad ?? 0n;
  let depositWad = 0n;
  if (need > free) {
    const shortfall = ceilToToken(need - free); // owed by the user ⇒ up
    const wallet = v.walletWad ?? 0n;
    if (wallet < shortfall) blockers.push({ kind: "fund", shortWad: shortfall - wallet });
    else if (v.venue === "perpl") blockers.push({ kind: "move", amountWad: shortfall });
    else blockers.push({ kind: "deposit", amountWad: shortfall });
    depositWad = shortfall;
  }
  return {
    venue: v.venue,
    label: v.label,
    eligible: line.eligible,
    reason: line.reason,
    sizeWad: size,
    stepWad: v.stepWad,
    quote: q,
    limitPriceWad,
    priceDp: v.priceDp,
    feeWad,
    marginWad,
    liqWad: liqPreview(v, q, size, marginWad, depositWad, buy),
    blockers,
  };
}

function liqPreview(v: VenueInput, q: VenueQuote, size: bigint, marginWad: bigint, depositWad: bigint, buy: boolean): bigint | undefined {
  const avg = q.walk.avgPriceWad;
  if (!v.liq || avg === undefined || size <= 0n) return undefined;
  if (v.liq.kind === "perpl") {
    const l = v.liq;
    const pd = 10n ** BigInt(18 - l.priceDecimals);
    const sd = 10n ** BigInt(18 - l.sizeDecimals);
    const cd = 10n ** BigInt(18 - l.collateralDecimals);
    const pricePNS = buy ? divCeil(avg, pd) : divFloor(avg, pd);
    const raw = { positionType: buy ? 0 : 1, depositCNS: divFloor(marginWad, cd), pricePNS, priceResiduePNSQ16: 0n, lotLNS: divFloor(size, sd), deltaPnlCNS: 0n, premiumPnlCNS: 0n };
    if (raw.lotLNS <= 0n || l.maintHdths <= 0n) return undefined;
    const r = perplPositionRisk(raw, pricePNS, { priceDecimals: l.priceDecimals, lotDecimals: l.sizeDecimals, maintMarginHdths: l.maintHdths });
    return r.liqPriceWad > 0n ? r.liqPriceWad : undefined;
  }
  const l = v.liq;
  const signed = buy ? size : -size;
  const pos = l.position;
  let sizeAfter = signed;
  let entry = avg;
  if (pos && pos.sizeWad !== 0n) {
    if (pos.sizeWad > 0n !== buy) return undefined; // reducing / flipping: the preview would be misleading
    const a = pos.sizeWad < 0n ? -pos.sizeWad : pos.sizeWad;
    sizeAfter = pos.sizeWad + signed;
    entry = buy ? divCeil(a * pos.entryWad + size * avg, a + size) : divFloor(a * pos.entryWad + size * avg, a + size);
  }
  // collateral after the deposit backs the whole (cross-margined) account; MATH_SPEC §3.2, long ↑ short ↓
  return meridianLiqOf(sizeAfter, entry, l.collateralWad + depositWad, l.mmrWad);
}

const meridianLiqOf = (sizeWad: bigint, entryWad: bigint, collateralWad: bigint, mmrWad: bigint) => liquidationPriceWad(entryWad, collateralWad, sizeWad, mmrWad);

// ── display ──

/** Fee owed, in cents rounded UP (never shows less than the user pays). */
export function feeText(feeWad: bigint): string {
  const cents = divCeil(feeWad, 10n ** 16n);
  return `$${formatFixed(cents, 2, 2)}`;
}

const dpOfStep = (stepWad: bigint) => {
  let dp = 18;
  let t = stepWad;
  while (dp > 0 && t % 10n === 0n) {
    t /= 10n;
    dp--;
  }
  return dp;
};

export const sizeText = (sizeWad: bigint, stepWad: bigint) => formatFixed(sizeWad, 18, dpOfStep(stepWad));
export const priceText = (priceWad: bigint | undefined, dp: number) => (priceWad === undefined ? "—" : `$${formatFixed(priceWad, 18, dp)}`);

/** "Long 120 MON on Perpl · worst price $0.02626 · fee $0.01 · liq $0.0190" (research §5.3). */
export function summaryText({ side, chosen: c }: { side: "long" | "short"; chosen: Chosen }): string {
  return `${side === "long" ? "Long" : "Short"} ${sizeText(c.sizeWad, c.stepWad)} MON on ${c.label} · worst price ${priceText(c.limitPriceWad, c.priceDp)} · fee ${feeText(c.feeWad)} · liq ${priceText(c.liqWad, c.priceDp)}`;
}
