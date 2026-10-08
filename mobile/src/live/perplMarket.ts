// Perpl MON market for the app: REST seed (ticker + 9.5 h of funding events) + one market-data socket (core
// MarketDataSocket: ≤ 16 subscriptions, reconnect on core's documented delays, RN WebSocket injected). The feed is
// sampled into a small store on every Meridian block (the app's heartbeat) and on funding events, so screens tick per
// block. Paused in background (socket closed). Units: core perpl/units (PNS/LNS → WAD, rate micros → APR WAD).
import {
  MarketDataFeed,
  MarketDataSocket,
  createPerplClient,
  httpTransport,
  perplRateToAprWad,
  pnsToWad,
  type PerplClient,
  type SocketEvent,
} from "@meridian/core/perpl";
import type { PerplDeployment } from "@meridian/core/meridian";
import { perplLevels, perplRealizedApr, perplWindowBlocks, type Realized } from "@meridian/core/route";
import type { Clock, FetchLike, WsFactory } from "@meridian/core/util";
import { errText } from "./blockStore";
import { Store } from "./store";

/** Realized-funding window shown next to the rate in force (the web terminal's 8 h tooltip window). */
export const REALIZED_WINDOW_SEC = 8n * 3600n;
/** No frame (or REST seed) for this long ⇒ the numbers are marked stale (frames arrive every block). */
export const PERPL_STALE_MS = 5_000;
/** REST backfill: a bit more than the window so the realized average has its first point. */
const BACKFILL_MS = 9.5 * 3600 * 1000;

export type PerplMarketState = {
  marketId: number;
  /** price decimals of the market (deployments/perpl.json, from /v1/pub/context) */
  priceDecimals: number;
  connected: boolean;
  markWad: bigint | undefined;
  bestBidWad: bigint | undefined;
  bestAskWad: bigint | undefined;
  /** the L2 book snapshot arrived (so undefined best bid/ask really means an empty side) */
  bookKnown: boolean;
  /** funding rate in force: micros of notional per interval (types.md FundingEvent.rate) */
  rateMicros: number | undefined;
  /** that rate annualized, WAD */
  aprNowWad: bigint | undefined;
  realized: Realized | undefined;
  /** Perpl's head block from heartbeats */
  headBlock: number | undefined;
  lastFrameMs: number | undefined;
  /** no data newer than PERPL_STALE_MS */
  stale: boolean;
  lastError: string | undefined;
};

export type PerplMarketDeps = {
  deployment: PerplDeployment;
  wsUrl: string;
  fetch: FetchLike;
  wsFactory: WsFactory;
  clock?: Clock;
  /** injected for tests; default: core's public client over `fetch` */
  client?: PerplClient;
};

export class PerplMarket {
  readonly store: Store<PerplMarketState>;
  readonly feed: MarketDataFeed;
  private readonly socket: MarketDataSocket;
  private readonly client: PerplClient;
  private readonly meta: PerplDeployment["markets"][number];
  private running = false;
  private seeded = false;
  private restMark: bigint | undefined;
  private restAtMs: number | undefined;

  constructor(private readonly d: PerplMarketDeps) {
    const id = d.deployment.monMarketId;
    const meta = d.deployment.markets[id];
    if (!meta) throw new Error(`perpl.json: market ${id} missing`);
    this.meta = meta;
    this.store = new Store<PerplMarketState>({ marketId: id, priceDecimals: meta.priceDecimals, connected: false, markWad: undefined, bestBidWad: undefined, bestAskWad: undefined, bookKnown: false, rateMicros: undefined, aprNowWad: undefined, realized: undefined, headBlock: undefined, lastFrameMs: undefined, stale: false, lastError: undefined });
    this.feed = new MarketDataFeed(id, 16);
    this.client = d.client ?? createPerplClient({ transport: httpTransport(d.deployment.apiUrl, d.fetch), ...(d.clock ? { clock: d.clock } : {}) });
    this.socket = new MarketDataSocket({
      baseUrl: d.wsUrl,
      chainId: d.deployment.chainId,
      feed: this.feed,
      factory: d.wsFactory,
      ...(d.clock ? { clock: d.clock } : {}),
      onFunding: () => this.sample(),
      onEvent: (e) => this.onSocketEvent(e),
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.socket.start();
    void this.seed();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.socket.stop();
    this.store.update({ connected: false });
  }

  /** REST seed / foreground refetch: ticker mark + funding history (the socket only sends new events). */
  async seed(): Promise<void> {
    const now = (this.d.clock ?? { now: Date.now }).now();
    try {
      const [state, events] = await Promise.all([this.client.getMarketState(this.meta.id), this.client.getFunding(this.meta.id, Math.floor(now - BACKFILL_MS), Math.floor(now))]);
      this.feed.backfill(events);
      if (state.mrk > 0) this.restMark = pnsToWad(state.mrk, this.meta.priceDecimals);
      this.restAtMs = (this.d.clock ?? { now: Date.now }).now();
      this.seeded = true;
      this.store.update({ lastError: undefined });
      this.sample();
    } catch (e) {
      this.store.update({ lastError: errText(e) });
    }
  }

  /** Copy the feed into the store (called per block and on funding events). Cheap: one book sort, a few bigints. */
  sample(): void {
    const f = this.feed;
    const pd = this.meta.priceDecimals;
    const sd = this.meta.sizeDecimals;
    const now = (this.d.clock ?? { now: Date.now }).now();
    const wsMark = f.state && f.state.value.mrk > 0 ? pnsToWad(f.state.value.mrk, pd) : undefined;
    const book = f.book.ready ? f.book.snapshot() : undefined;
    const inForce = f.fundingInForce(now);
    const headBlock = f.head?.block;
    let realized: Realized | undefined;
    if (headBlock !== undefined) {
      const points = f.fundingEvents().map((e) => ({ feb: BigInt(e.feb), aprWad: perplRateToAprWad(e.rate, this.meta.fundingIntervalSec) }));
      realized = perplRealizedApr(points, BigInt(headBlock), perplWindowBlocks(REALIZED_WINDOW_SEC, BigInt(this.meta.fundingIntervalSec), BigInt(this.meta.fundingIntervalBlocks)));
    }
    const newest = Math.max(f.lastFrameMs ?? -Infinity, this.restAtMs ?? -Infinity);
    const stale = Number.isFinite(newest) && now - newest > PERPL_STALE_MS;
    const prev = this.store.get();
    this.store.update({
      markWad: wsMark ?? this.restMark,
      bestBidWad: book ? perplLevels(book.bid, pd, sd)[0]?.priceWad : undefined,
      bestAskWad: book ? perplLevels(book.ask, pd, sd)[0]?.priceWad : undefined,
      bookKnown: book !== undefined,
      rateMicros: inForce?.rate,
      aprNowWad: inForce ? perplRateToAprWad(inForce.rate, this.meta.fundingIntervalSec) : undefined,
      // keep the object identity when the value is unchanged (subscribers compare by reference)
      realized: realized && prev.realized && realized.aprWad === prev.realized.aprWad && realized.windowBlocks === prev.realized.windowBlocks ? prev.realized : realized,
      headBlock,
      lastFrameMs: f.lastFrameMs,
      stale,
    });
  }

  private onSocketEvent(e: SocketEvent): void {
    if (e.kind === "open") this.store.update({ connected: true });
    else if (e.kind === "close") this.store.update({ connected: false, lastError: `socket closed (${e.code}), reconnecting in ${Math.round(e.reconnectInMs / 1000)} s` });
    else if (e.kind === "subscribed") {
      const bad = e.subs.find((s) => s.code !== 0);
      this.store.update(bad ? { lastError: `subscribe ${bad.stream}: ${bad.error ?? bad.code}` } : { lastError: undefined });
    }
  }
}
