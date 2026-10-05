// Chart datafeed types (FRONTEND_TRADE_PLAN §4.4). Money stays bigint WAD; the engine converts at its boundary.

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1D";

export const TIMEFRAME_SEC: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "4h": 14_400, "1D": 86_400 };

/** Indexer table each timeframe is built from (1m-based frames from Candle1m, the rest from Candle1h). */
export const SOURCE_OF: Record<Timeframe, "Candle1m" | "Candle1h"> = { "1m": "Candle1m", "5m": "Candle1m", "15m": "Candle1m", "1h": "Candle1h", "4h": "Candle1h", "1D": "Candle1h" };

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
