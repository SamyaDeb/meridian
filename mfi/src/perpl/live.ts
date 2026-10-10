// The Perpl venue read from the market-data WebSocket, with the REST read (client.ts) as backfill and fallback.
// WS first: funding arrives within one message of Perpl publishing it (types.md "FundingEvent": rate, then final `at.t`).
// REST when the feed has been silent > `wsMaxSilenceMs` or lacks state/funding (MFI.md §5 rules apply either way).
import { readPerplVenue, type PerplClient, type PerplVenueRead } from "./client";
import { PerplUnavailableError } from "./errors";
import type { Market } from "./types";
import { perplOiNotionalWad, perplRateToAprWad, scaledToWad } from "./units";
import type { MarketDataFeed } from "./ws";

export type PerplSourceRead = PerplVenueRead & { source: "ws" | "rest" };

/** Venue read from the feed alone; undefined when the feed is silent for longer than `maxSilenceMs` or incomplete. */
export function perplVenueFromFeed(feed: MarketDataFeed, market: Market, nowMs: number, maxSilenceMs: number): PerplSourceRead | undefined {
  if (feed.lastFrameMs === undefined || nowMs - feed.lastFrameMs > maxSilenceMs) return undefined;
  const st = feed.state?.value;
  const ev = feed.fundingInForce(nowMs);
  if (!st || !ev) return undefined;
  // decimals from the live market-config stream when we have it (they can change), else from /v1/pub/context
  const pd = feed.config?.value.priceDecimals ?? market.config.price_decimals;
  const sd = feed.config?.value.sizeDecimals ?? market.config.size_decimals;
  const fees = feed.config?.value.fees ?? market.config.fees;
  return {
    marketId: market.id,
    aprWad: perplRateToAprWad(ev.rate, market.funding_interval_sec),
    rateMicros: ev.rate,
    fundingIntervalSec: market.funding_interval_sec,
    fundingEventBlock: ev.feb,
    fundingAtMs: ev.at.t,
    oiNotionalWad: perplOiNotionalWad(st.oi, sd, st.mrk, pd),
    markWad: scaledToWad(st.mrk, pd),
    stateAtMs: st.at.t,
    ...(fees ? { fees } : {}),
    source: "ws",
  };
}

/** WS when fresh, otherwise one REST read (which also backfills the feed's funding history). */
export async function readPerplLive(client: PerplClient, feed: MarketDataFeed | undefined, market: Market, nowMs: number, opts: { wsMaxSilenceMs?: number } = {}): Promise<PerplSourceRead> {
  if (feed) {
    if (feed.marketId !== market.id) throw new PerplUnavailableError("unknown-market", `feed follows market ${feed.marketId}, not ${market.id}`);
    const live = perplVenueFromFeed(feed, market, nowMs, opts.wsMaxSilenceMs ?? 10_000);
    if (live) return live;
  }
  const read = await readPerplVenue(client, market, nowMs);
  if (feed) {
    const iv = market.funding_interval_sec * 1000;
    feed.backfill(await client.getFunding(market.id, nowMs - 2 * iv, nowMs + iv));
  }
  return { ...read, ...(market.config.fees ? { fees: market.config.fees } : {}), source: "rest" };
}
