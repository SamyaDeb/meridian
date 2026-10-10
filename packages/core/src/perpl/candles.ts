// Perpl OHLCV candles: api-docs @ 25ab6e2 rest-endpoints.md "GET /api/v1/market-data/:market_id/candles/:resolution/:from-:to"
// (resolution in seconds, from/to in ms, ≤ 1024 candles per request, an empty market returns an empty `d`) and types.md
// "Candle" (t open ms, o/c/h/l prices scaled by price_decimals, v volume in collateral units as a decimal string, n trades).
// Validation only; the client method lives in ./client.
import { PerplSchemaError } from "./errors";

/** rest-endpoints.md "Supported Resolutions" (seconds). Anything else is refused before a request is made. */
export const CANDLE_RESOLUTIONS_SEC = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] as const;
export type CandleResolution = (typeof CANDLE_RESOLUTIONS_SEC)[number];
/** rest-endpoints.md "Limits": maximum 1024 candles per request. */
export const MAX_CANDLES_PER_REQUEST = 1024;

export type Candle = { t: number; o: number; c: number; h: number; l: number; v: string; n: number };
export type CandleSeries = { mt: number; r: number; d: Candle[] };

export const isCandleResolution = (r: number): r is CandleResolution => (CANDLE_RESOLUTIONS_SEC as readonly number[]).includes(r);

type Obj = Record<string, unknown>;
const obj = (v: unknown, path: string): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PerplSchemaError(path, "expected object");
  return v as Obj;
};
const int = (o: Obj, k: string, path: string, min = 0): number => {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new PerplSchemaError(`${path}.${k}`, `expected safe integer >= ${min}`);
  return v;
};

function candle(v: unknown, path: string): Candle {
  const o = obj(v, path);
  const vol = o.v;
  if (typeof vol !== "string" || !/^\d+$/.test(vol)) throw new PerplSchemaError(`${path}.v`, "expected a decimal string");
  const c: Candle = { t: int(o, "t", path), o: int(o, "o", path), c: int(o, "c", path), h: int(o, "h", path), l: int(o, "l", path), v: vol, n: int(o, "n", path) };
  if (c.h < c.l) throw new PerplSchemaError(path, "high below low");
  return c;
}

/** CandleSeries → validated, oldest first, one candle per open time (a repeated `t` keeps the later copy). */
export function parseCandleSeries(v: unknown): CandleSeries {
  const o = obj(v, "candles");
  const d = o.d;
  if (!Array.isArray(d)) throw new PerplSchemaError("candles.d", "expected array");
  const byT = new Map<number, Candle>();
  d.forEach((x, i) => {
    const c = candle(x, `candles.d[${i}]`);
    byT.set(c.t, c);
  });
  return { mt: int(o, "mt", "candles"), r: int(o, "r", "candles", 1), d: [...byT.values()].sort((a, b) => a.t - b.t) };
}

/** The window for the newest `count` candles at `resolutionSec` ending at `nowMs`: from aligned down to the resolution. */
export function candleWindow(resolutionSec: number, nowMs: number, count: number): { fromMs: number; toMs: number } {
  if (!isCandleResolution(resolutionSec)) throw new RangeError(`unsupported candle resolution ${resolutionSec}s`);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CANDLES_PER_REQUEST) throw new RangeError(`count must be 1–${MAX_CANDLES_PER_REQUEST}`);
  const step = resolutionSec * 1000;
  const lastOpen = nowMs - (nowMs % step);
  return { fromMs: lastOpen - (count - 1) * step, toMs: nowMs };
}
