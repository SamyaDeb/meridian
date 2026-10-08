// Runtime validation of Perpl payloads: anything off-schema throws PerplSchemaError (never a silently wrong rate).
// Ported from meridian-k3/mfi/src/perpl/validate.ts (perpl-hedge @ 116e26d; main @ 0ba1664 minus fees) + parseL2Book.
import { PerplSchemaError } from "./errors";
import type { BlockTimestamp, Context, FundingEvent, FundingSeries, L2Book, L2Level, Market, MarketState, MarketStateUpdate, PerplFees } from "./types";

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PerplSchemaError(path, "expected object");
  return v as Obj;
}
function int(o: Obj, k: string, path: string, opts: { min?: number } = {}): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new PerplSchemaError(`${path}.${k}`, "expected safe integer");
  if (opts.min !== undefined && v < opts.min) throw new PerplSchemaError(`${path}.${k}`, `expected >= ${opts.min}`);
  return v;
}
function str(o: Obj, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new PerplSchemaError(`${path}.${k}`, "expected string");
  return v;
}
function bool(o: Obj, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new PerplSchemaError(`${path}.${k}`, "expected boolean");
  return v;
}
function arr(o: Obj, k: string, path: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new PerplSchemaError(`${path}.${k}`, "expected array");
  return v;
}

function blockTs(v: unknown, path: string): BlockTimestamp {
  const o = obj(v, path);
  const out: BlockTimestamp = {};
  if (o.b !== undefined) out.b = int(o, "b", path, { min: 0 });
  if (o.t !== undefined) out.t = int(o, "t", path, { min: 0 });
  return out;
}

export function parseFundingEvent(v: unknown, path = "funding"): FundingEvent {
  const o = obj(v, path);
  return {
    at: blockTs(o.at, `${path}.at`),
    feb: int(o, "feb", path, { min: 0 }),
    rate: int(o, "rate", path),
    idx: int(o, "idx", path, { min: 0 }),
    ppl: int(o, "ppl", path),
    sum: int(o, "sum", path),
    div: int(o, "div", path),
  };
}

export function parseMarketState(v: unknown, path = "state"): MarketState {
  const o = obj(v, path);
  const p = (k: string) => int(o, k, path, { min: 0 });
  return { at: blockTs(o.at, `${path}.at`), orl: p("orl"), mrk: p("mrk"), lst: p("lst"), mid: p("mid"), bid: p("bid"), ask: p("ask"), oi: p("oi") };
}

const decimals = (o: Obj, k: string, path: string) => {
  const d = int(o, k, path, { min: 0 });
  if (d > 18) throw new PerplSchemaError(`${path}.${k}`, "decimals > 18 not supported");
  return d;
};

function intArr(o: Obj, k: string, path: string): number[] | undefined {
  if (o[k] === undefined) return undefined; // omitempty (README "Fees & fee tiers": missing array = base tier only)
  const a = arr(o, k, path);
  return a.map((_, i) => int(a as unknown as Obj, String(i), `${path}.${k}`));
}

/** MarketConfig fee schedule (micros), or undefined when the payload carries none. */
export function parseFees(c: Obj, path: string): PerplFees | undefined {
  if (c.maker_fee === undefined && c.taker_fee === undefined) return undefined;
  const makerTiers = intArr(c, "maker_fees", path);
  const takerTiers = intArr(c, "taker_fees", path);
  return { makerMicros: int(c, "maker_fee", path), takerMicros: int(c, "taker_fee", path), ...(makerTiers ? { makerTiers } : {}), ...(takerTiers ? { takerTiers } : {}) };
}

export function parseMarket(v: unknown, path = "market"): Market {
  const o = obj(v, path);
  const c = obj(o.config, `${path}.config`);
  const fees = parseFees(c, `${path}.config`);
  return {
    id: int(o, "id", path, { min: 0 }),
    symbol: str(o, "symbol", path),
    name: str(o, "name", path),
    funding_interval_sec: int(o, "funding_interval_sec", path, { min: 1 }),
    funding_interval_blocks: int(o, "funding_interval_blocks", path, { min: 0 }),
    ...(o.order_ttl_blocks !== undefined ? { order_ttl_blocks: int(o, "order_ttl_blocks", path, { min: 1 }) } : {}),
    config: {
      is_open: bool(c, "is_open", `${path}.config`),
      price_decimals: decimals(c, "price_decimals", `${path}.config`),
      size_decimals: decimals(c, "size_decimals", `${path}.config`),
      ...(fees ? { fees } : {}),
    },
  };
}

export function parseContext(v: unknown): Context {
  const o = obj(v, "context");
  const chain = obj(o.chain, "context.chain");
  return { chain: { chain_id: int(chain, "chain_id", "context.chain") }, markets: arr(o, "markets", "context").map((m, i) => parseMarket(m, `context.markets[${i}]`)) };
}

export function parseMarketStateUpdate(v: unknown): MarketStateUpdate {
  const o = obj(v, "ticker");
  const d = obj(o.d, "ticker.d");
  const out: Record<string, MarketState> = {};
  for (const [k, s] of Object.entries(d)) {
    if (!/^\d+$/.test(k)) throw new PerplSchemaError(`ticker.d.${k}`, "market id key must be an integer");
    out[k] = parseMarketState(s, `ticker.d.${k}`);
  }
  return { mt: int(o, "mt", "ticker"), sn: int(o, "sn", "ticker", { min: 0 }), d: out };
}

export function parseFundingSeries(v: unknown): FundingSeries {
  const o = obj(v, "fundingSeries");
  return {
    mt: int(o, "mt", "fundingSeries"),
    at: blockTs(o.at, "fundingSeries.at"),
    m: int(o, "m", "fundingSeries", { min: 0 }),
    d: arr(o, "d", "fundingSeries").map((e, i) => parseFundingEvent(e, `fundingSeries.d[${i}]`)),
  };
}

function level(v: unknown, path: string): L2Level {
  const o = obj(v, path);
  return { p: int(o, "p", path, { min: 0 }), s: int(o, "s", path, { min: 0 }), o: int(o, "o", path, { min: 0 }) };
}

/** types.md "L2Book" (WS mt 15 / 16, REST GET /v1/market-data/:id/book). Sides best first. */
export function parseL2Book(v: unknown, path = "book"): L2Book {
  const o = obj(v, path);
  const mt = int(o, "mt", path);
  if (mt !== 15 && mt !== 16) throw new PerplSchemaError(`${path}.mt`, "expected 15 (snapshot) or 16 (update)");
  return {
    mt,
    ...(o.sn !== undefined ? { sn: int(o, "sn", path, { min: 0 }) } : {}),
    ...(o.sid !== undefined ? { sid: int(o, "sid", path) } : {}),
    at: o.at === undefined ? {} : blockTs(o.at, `${path}.at`),
    bid: arr(o, "bid", path).map((l, i) => level(l, `${path}.bid[${i}]`)),
    ask: arr(o, "ask", path).map((l, i) => level(l, `${path}.ask[${i}]`)),
  };
}
