// Chart datafeed types (FRONTEND_TRADE_PLAN §4.4). Money stays bigint WAD; the engine converts at its boundary.

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1D" | "1W";
export const TIMEFRAMES: readonly Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1D", "1W"];

export const TIMEFRAME_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1_800,
  "1h": 3_600,
  "2h": 7_200,
  "4h": 14_400,
  "6h": 21_600,
  "12h": 43_200,
  "1D": 86_400,
  "1W": 604_800,
};

/** Weeks start Monday 00:00 UTC (the unix epoch was a Thursday): bucket offset in seconds. Other frames: 0. */
export const ALIGN_OFFSET_SEC: Partial<Record<Timeframe, number>> = { "1W": 4 * 86_400 };

/** Indexer table each timeframe is built from (sub-hour frames from Candle1m, the rest from Candle1h). */
export const SOURCE_OF: Record<Timeframe, "Candle1m" | "Candle1h"> = {
  "1m": "Candle1m",
  "3m": "Candle1m",
  "5m": "Candle1m",
  "15m": "Candle1m",
  "30m": "Candle1m",
  "1h": "Candle1h",
  "2h": "Candle1h",
  "4h": "Candle1h",
  "6h": "Candle1h",
  "12h": "Candle1h",
  "1D": "Candle1h",
  "1W": "Candle1h",
};

/** What the main series draws: trades on Meridian's book, the mark price, or the oracle index. */
export type PriceSource = "last" | "mark" | "index";

export type Bar = {
  /** bucket start, unix seconds (UTC aligned) */
  time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeBaseWad: bigint;
  volumeQuoteWad: bigint;
  trades: number;
  /** empty bucket carried from the previous close with zero volume (never a real trade) */
  gapFill?: true;
};
