// Activity (MOBILE_PLAN N7 §7, research §5.2): one list, newest first, of what happened to the user's money on both
// venues, each row opening a receipt. Pure: parse each source into rows, then merge (dedupe across sources, sort).
//
// Sources (nothing invented):
//  - this app's own trade receipts (log.ts): the richest row for a trade the app placed; and its Earn runs (N6: open,
//    close, the one-tap leftover close), one row per run that opens the Earn timeline and stands in for its legs' fills;
//  - Perpl, signed REST (github.com/PerplFoundation/api-docs rest-endpoints.md "Trading History Endpoints"):
//    GET /v1/trading/fills (Fill: at, mkt, oid, t OrderType, p PNS, s LNS, f fee CNS) grouped per order, and
//    GET /v1/trading/account-history (AccountEvent: at, et, a amount change CNS) for Deposit 1 / Withdrawal 2 /
//    Liquidation 5 / Funding 8. Amounts are integer CNS strings (as `b`/`lb`, core perpl/state availableCollateral);
//  - Meridian, the Envio indexer (indexer/schema.graphql Trade, FundingPayment, Liquidation; same query shape as the
//    web app's app/src/data/indexer/account.ts), only when the build has an indexer URL.
import type { Venue } from "@meridian/core/route";
import { divTrunc, WAD } from "@meridian/core/util";
import type { Fill } from "@meridian/core/perpl";
import type { EarnTimeline } from "../earn/timeline";
import type { Receipt } from "../trade/exec/receipt";
import { sizeText } from "../trade/ticket/quote";

export type ActivityKind = "trade" | "deposit" | "withdrawal" | "funding" | "liquidation" | "earn";

export type ActivityItem = {
  /** dedupe key, the same for one event whichever source reported it (perpl-order-<oid>, meridian-tx-<hash>, …) */
  id: string;
  kind: ActivityKind;
  /** "both": an Earn run (a leg on each venue) */
  venue: Venue | "both";
  /** plain words: "Long 120 MON", "Deposit", "Funding received" */
  title: string;
  /** a second line before venue · time (an Earn run's sizes) */
  detail?: string;
  /** AUSD that moved for the user, WAD, signed (+ in, − out); undefined for a trade (its receipt has the detail) */
  amountWad: bigint | undefined;
  /** ms since epoch; undefined sorts last */
  atMs: number | undefined;
  block: bigint | undefined;
  txHash: string | undefined;
  /** trades open the receipt modal with this */
  receipt: Receipt | undefined;
  /** Earn runs open the Earn receipt (timeline) with this */
  earn?: EarnTimeline;
  /** ids of other sources' rows this one stands for (an Earn run's legs: their Perpl fills / Meridian trades) */
  alsoIds?: readonly string[];
};

/**
 * Sources in priority order: the first to report an id wins (the app's own receipt has the summary the user saw); a row
 * that stands for others (an Earn run) hides them, so a leg isn't listed twice.
 */
export function mergeActivity(...sources: readonly (readonly ActivityItem[])[]): ActivityItem[] {
  const seen = new Map<string, ActivityItem>();
  const claimed = new Set<string>();
  for (const list of sources)
    for (const it of list) {
      if (seen.has(it.id) || claimed.has(it.id)) continue;
      seen.set(it.id, it);
      for (const a of it.alsoIds ?? []) if (a !== it.id) claimed.add(a);
    }
  return [...seen.values()].filter((it) => !claimed.has(it.id)).sort(byNewest);
}

function byNewest(a: ActivityItem, b: ActivityItem): number {
  if (a.atMs !== b.atMs) {
    if (a.atMs === undefined) return 1;
    if (b.atMs === undefined) return -1;
    return b.atMs - a.atMs;
  }
  if (a.block !== b.block) {
    if (a.block === undefined) return 1;
    if (b.block === undefined) return -1;
    return a.block > b.block ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const tradeIdOf = (venue: Venue, orderId: number | undefined, txHash: string | undefined): string | undefined =>
  venue === "perpl" ? (orderId !== undefined ? `perpl-order-${orderId}` : undefined) : txHash ? `meridian-tx-${txHash.toLowerCase()}` : undefined;

export function tradeTitle(r: Pick<Receipt, "side" | "reduceOnly" | "filledWad" | "stepWad">): string {
  const size = `${sizeText(r.filledWad, r.stepWad)} MON`;
  if (r.reduceOnly) return `Closed ${r.side} ${size}`;
  return `${r.side === "long" ? "Long" : "Short"} ${size}`;
}

// ── this app's receipts ──

export type LoggedReceipt = { atMs: number; block: bigint | undefined; receipt: Receipt };

/**
 * An Earn run as Activity keeps it (non-secret: sizes, order ids, tx hashes, the plain timeline). Open / close carry
 * the run's timeline (without the live one-tap close: history never places an order) and their legs' activity ids;
 * the one-tap leftover close is a Trade order, kept with its receipt.
 */
export type EarnRunEntry =
  | { run: "open" | "close"; runId: string; perplWad: bigint; meridianWad: bigint; lockWad?: bigint; stepWad: bigint; timeline: EarnTimeline; legIds: string[] }
  | { run: "leftover"; runId: string; receipt: Receipt };

export type LoggedEarn = { kind: "earn"; atMs: number; block: bigint | undefined; earn: EarnRunEntry };

/** What the app's log holds: trade receipts (v1 entries, no `kind`) and Earn runs. */
export type LogEntry = LoggedReceipt | LoggedEarn;

export const isEarnEntry = (e: LogEntry): e is LoggedEarn => "kind" in e && e.kind === "earn";

/** The activity id a log entry is listed under (a newer entry with the same id replaces the older one). */
export function logEntryId(e: LogEntry): string | undefined {
  if (!isEarnEntry(e)) return tradeIdOf(e.receipt.venue, e.receipt.orderId, e.receipt.txHash);
  return e.earn.run === "leftover" ? (tradeIdOf(e.earn.receipt.venue, e.earn.receipt.orderId, e.earn.receipt.txHash) ?? `earn-${e.earn.runId}`) : `earn-${e.earn.runId}`;
}

function fromEarn(e: LoggedEarn): ActivityItem {
  const x = e.earn;
  if (x.run === "leftover") {
    const r = x.receipt;
    return { id: logEntryId(e)!, kind: "earn", venue: r.venue, title: `Earn leftover closed: ${sizeText(r.filledWad, r.stepWad)} MON`, amountWad: undefined, atMs: e.atMs, block: e.block, txHash: r.txHash, receipt: r };
  }
  const mon = (w: bigint) => sizeText(w, x.stepWad);
  const detail = `Perpl ${mon(x.perplWad)} · Meridian ${mon(x.meridianWad)} MON${x.lockWad !== undefined && x.lockWad > 0n ? ` · lock ${mon(x.lockWad)} MON` : ""}`;
  return { id: `earn-${x.runId}`, kind: "earn", venue: "both", title: `Earn ${x.run === "open" ? "open" : "close"} · ${x.timeline.headline}`, detail, amountWad: undefined, atMs: e.atMs, block: e.block, txHash: undefined, receipt: undefined, earn: x.timeline, alsoIds: x.legIds };
}

export function fromLog(entries: readonly LogEntry[]): ActivityItem[] {
  return entries.flatMap((e, i) => {
    if (isEarnEntry(e)) return [fromEarn(e)];
    const r = e.receipt;
    if (!r.ok) return []; // nothing filled ⇒ nothing happened to the money
    const id = tradeIdOf(r.venue, r.orderId, r.txHash) ?? `app-${e.atMs}-${i}`;
    return [{ id, kind: "trade" as const, venue: r.venue, title: tradeTitle(r), amountWad: undefined, atMs: e.atMs, block: e.block, txHash: r.txHash, receipt: r }];
  });
}

// ── Perpl ──

export type PerplMarketMeta = { id: number; priceDecimals: number; sizeDecimals: number; collateralDecimals: number };

/** types.md OrderType: 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort; anything else isn't a trade row. */
const PERPL_TRADE: Record<number, { side: "long" | "short"; reduceOnly: boolean }> = {
  1: { side: "long", reduceOnly: false },
  2: { side: "short", reduceOnly: false },
  3: { side: "long", reduceOnly: true },
  4: { side: "short", reduceOnly: true },
};

const pow10 = (n: number) => 10n ** BigInt(n);
/** Perpl reports `txid` as bare hex (recorded fills: packages/core/fixtures/perpl/testnet/trading/history-fills.json). */
export const hex0x = (h: string | undefined): string | undefined => (h ? (h.startsWith("0x") ? h : `0x${h}`).toLowerCase() : undefined);
const toWad = (raw: bigint, decimals: number) => raw * pow10(18 - decimals);
const cnsInt = (v: unknown): bigint | undefined => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : undefined);

/** Fills of the MON market grouped per order → one trade row each (size Σ, average price size-weighted, fee Σ). */
export function perplTrades(fills: readonly Fill[], m: PerplMarketMeta, explorerBase?: string): ActivityItem[] {
  const byOrder = new Map<number, Fill[]>();
  for (const f of fills) {
    if (f.mkt !== m.id || PERPL_TRADE[f.t] === undefined || !(f.s > 0)) continue;
    const l = byOrder.get(f.oid) ?? [];
    l.push(f);
    byOrder.set(f.oid, l);
  }
  const out: ActivityItem[] = [];
  for (const [oid, list] of byOrder) {
    const kind = PERPL_TRADE[list[0]!.t]!;
    let lots = 0n;
    let pxLots = 0n;
    let priced = 0n;
    let fee: bigint | undefined = 0n;
    for (const f of list) {
      lots += BigInt(f.s);
      if (f.p !== undefined) {
        pxLots += BigInt(f.p) * BigInt(f.s);
        priced += BigInt(f.s);
      }
      const ff = cnsInt(f.f);
      fee = fee === undefined || ff === undefined ? undefined : fee + ff;
    }
    const at = latest(list.map((f) => f.at));
    const stepWad = pow10(18 - m.sizeDecimals);
    const filledWad = lots * stepWad;
    // display average, truncated (a reference value, not a payment)
    const avgPriceWad = priced > 0n ? divTrunc(pxLots * pow10(18 - m.priceDecimals), priced) : undefined;
    const txHash = at.txid;
    const receipt: Receipt = {
      ok: true,
      venue: "perpl",
      side: kind.side,
      reduceOnly: kind.reduceOnly,
      summary: "",
      filledWad,
      stepWad,
      avgPriceWad,
      priceDp: m.priceDecimals,
      feeWad: fee === undefined ? undefined : toWad(fee, m.collateralDecimals),
      orderId: oid,
      txHash: txHash as Receipt["txHash"],
      explorerTxUrl: txHash && explorerBase ? `${explorerBase.replace(/\/+$/, "")}/tx/${txHash}` : undefined,
      blocksToFill: undefined,
      error: undefined,
    };
    receipt.summary = `${tradeTitle(receipt)} on Perpl`;
    out.push({ id: `perpl-order-${oid}`, kind: "trade", venue: "perpl", title: tradeTitle(receipt), amountWad: undefined, atMs: at.t, block: at.b, txHash, receipt });
  }
  return out;
}

function latest(ats: readonly (Fill["at"] | undefined)[]): { t: number | undefined; b: bigint | undefined; txid: string | undefined } {
  let best: Fill["at"] | undefined;
  for (const a of ats) if (a && (best === undefined || (a.b ?? 0) > (best.b ?? 0))) best = a;
  return { t: best?.t, b: best?.b !== undefined ? BigInt(best.b) : undefined, txid: hex0x(best?.txid) };
}

/** account-history AccountEvent (rest-endpoints.md), the fields the list uses. */
export type PerplAccountEvent = { at?: { b?: number; t?: number; txid?: string; l?: number }; id?: number; et: number; m?: number; a: string };

/** Deposit / Withdrawal / Liquidation / Funding rows; settlement and collateral moves are part of a trade's own row. */
export function perplAccountEvents(events: readonly PerplAccountEvent[], collateralDecimals: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of events) {
    const kind: ActivityKind | undefined = e.et === 1 ? "deposit" : e.et === 2 ? "withdrawal" : e.et === 5 ? "liquidation" : e.et === 8 ? "funding" : undefined;
    const a = cnsInt(e.a);
    if (!kind || a === undefined) continue;
    const amountWad = toWad(kind === "withdrawal" && a > 0n ? -a : a, collateralDecimals);
    const title = kind === "deposit" ? "Deposit to Perpl" : kind === "withdrawal" ? "Withdrawal from Perpl" : kind === "liquidation" ? "Liquidation on Perpl" : amountWad >= 0n ? "Funding received" : "Funding paid";
    const tx = hex0x(e.at?.txid);
    out.push({ id: `perpl-acc-${e.at?.b ?? "?"}-${tx ?? ""}-${e.at?.l ?? ""}-${e.et}`, kind, venue: "perpl", title, amountWad, atMs: e.at?.t, block: e.at?.b !== undefined ? BigInt(e.at.b) : undefined, txHash: tx, receipt: undefined });
  }
  return out;
}

// ── Meridian (indexer) ──

/** > VERIFY: root-field names and `_ilike` on address strings against the live Hasura console (web account.ts caveat). */
export const MERIDIAN_ACTIVITY_QUERY = `query MeridianActivity($a: String!, $limit: Int!) {
  Trade(where: { kind: { _eq: "Perp" }, _or: [{ maker: { _ilike: $a } }, { taker: { _ilike: $a } }] }, order_by: { block: desc }, limit: $limit) {
    id maker taker takerIsBid priceWad sizeWad block timestamp txHash
  }
  FundingPayment(where: { account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    id payment block timestamp txHash
  }
  Liquidation(where: { kind: { _eq: "Perp" }, account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    id sizeTransferred block timestamp txHash
  }
}`;

type Raw = Record<string, unknown>;
const rows = (d: unknown, k: string): Raw[] => {
  const v = ((d ?? {}) as Record<string, unknown>)[k];
  if (!Array.isArray(v)) throw new Error(`indexer: no ${k} field`);
  return v as Raw[];
};
const big = (v: unknown, name: string): bigint => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`indexer: bad ${name}`);
};

/**
 * GraphQL data → rows. Fills of one transaction are one trade (a taker order walks several makers); the side is the
 * account's: taker ⇒ takerIsBid, maker ⇒ the opposite. Garbled rows throw (the list then says the source failed).
 */
export function meridianActivity(data: unknown, account: string, m: { priceDp: number; lotSizeWad: bigint | undefined; explorerBase?: string }): ActivityItem[] {
  const me = account.toLowerCase();
  type G = { buy: boolean; size: bigint; notional: bigint; block: bigint; ts: bigint; tx: string };
  const groups = new Map<string, G>();
  for (const r of rows(data, "Trade")) {
    const taker = String(r.taker).toLowerCase() === me;
    const buy = taker ? Boolean(r.takerIsBid) : !r.takerIsBid;
    const tx = String(r.txHash).toLowerCase();
    const key = `${tx}-${taker ? "t" : "m"}`;
    const size = big(r.sizeWad, "sizeWad");
    const price = big(r.priceWad, "priceWad");
    const g = groups.get(key) ?? { buy, size: 0n, notional: 0n, block: big(r.block, "block"), ts: big(r.timestamp, "timestamp"), tx };
    g.size += size;
    g.notional += size * price;
    groups.set(key, g);
  }
  const out: ActivityItem[] = [];
  for (const g of groups.values()) {
    const stepWad = m.lotSizeWad ?? WAD;
    const side = g.buy ? "long" : "short";
    const receipt: Receipt = {
      ok: true,
      venue: "meridian",
      side,
      // the indexer doesn't say whether a fill opened or reduced; the row reads as the direction traded
      reduceOnly: false,
      summary: "",
      filledWad: g.size,
      stepWad,
      avgPriceWad: g.size > 0n ? g.notional / g.size : undefined,
      priceDp: m.priceDp,
      feeWad: undefined,
      orderId: undefined,
      txHash: g.tx as Receipt["txHash"],
      explorerTxUrl: m.explorerBase ? `${m.explorerBase.replace(/\/+$/, "")}/tx/${g.tx}` : undefined,
      blocksToFill: undefined,
      error: undefined,
    };
    const title = `${g.buy ? "Bought" : "Sold"} ${sizeText(g.size, stepWad)} MON`;
    receipt.summary = `${title} on Meridian`;
    out.push({ id: `meridian-tx-${g.tx}`, kind: "trade", venue: "meridian", title, amountWad: undefined, atMs: Number(g.ts) * 1000, block: g.block, txHash: g.tx, receipt });
  }
  for (const r of rows(data, "FundingPayment")) {
    const paid = big(r.payment, "payment"); // > 0 = the account paid (schema.graphql)
    out.push({ id: `meridian-funding-${String(r.id)}`, kind: "funding", venue: "meridian", title: paid > 0n ? "Funding paid" : "Funding received", amountWad: -paid, atMs: Number(big(r.timestamp, "timestamp")) * 1000, block: big(r.block, "block"), txHash: String(r.txHash), receipt: undefined });
  }
  for (const r of rows(data, "Liquidation")) {
    // the loss is the position's, not one amount: the row has no amount (the explorer has the transaction)
    out.push({ id: `meridian-liq-${String(r.id)}`, kind: "liquidation", venue: "meridian", title: "Liquidation on Meridian", amountWad: undefined, atMs: Number(big(r.timestamp, "timestamp")) * 1000, block: big(r.block, "block"), txHash: String(r.txHash), receipt: undefined });
  }
  return out;
}

// ── display ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now" · "5 min ago" · "3 h ago" · "9 Oct" (device-local date); unknown time ⇒ the block, else "—". */
export function whenText(atMs: number | undefined, nowMs: number, block?: bigint): string {
  if (atMs === undefined) return block !== undefined ? `block ${block}` : "—";
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(atMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
