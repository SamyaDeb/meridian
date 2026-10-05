// Perpl REST types: the subset MFI reads. Source: github.com/PerplFoundation/api-docs @ 25ab6e2, types.md.
// JSON numbers are kept as `number` only when they are safe integers (validate.ts rejects the rest).

/** Block/timestamp; `t` in ms. */
export type BlockTimestamp = { b?: number; t?: number };

/** types.md "FundingEvent". `rate` in micros (10^-6). > VERIFY: per funding interval, positive ⇒ longs pay (MFI.md §2). */
export type FundingEvent = { at: BlockTimestamp; feb: number; rate: number; idx: number; ppl: number; sum: number; div: number };

/** types.md "MarketState" (prices scaled by price_decimals, sizes by size_decimals). */
export type MarketState = { at: BlockTimestamp; orl: number; mrk: number; lst: number; mid: number; bid: number; ask: number; oi: number };

/** types.md "MarketConfig" (subset). */
export type MarketConfig = { is_open: boolean; price_decimals: number; size_decimals: number };

/** types.md "Market" (subset). */
export type Market = {
  id: number;
  symbol: string;
  name: string;
  funding_interval_sec: number;
  funding_interval_blocks: number;
  config: MarketConfig;
};

/** GET /v1/pub/context (subset). */
export type Context = { chain: { chain_id: number }; markets: Market[] };

/** GET /v1/market-data/:id/ticker and /v1/market-data/ticker: keyed by market id. */
export type MarketStateUpdate = { mt: number; sn: number; d: Record<string, MarketState> };

/** GET /v1/market-data/:id/funding/:from-:to */
export type FundingSeries = { mt: number; at: BlockTimestamp; m: number; d: FundingEvent[] };
