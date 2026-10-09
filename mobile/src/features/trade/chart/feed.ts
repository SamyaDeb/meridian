// Chart data for the Trade screen: Perpl candles (core getCandles; resolutions from api-docs rest-endpoints.md) cached
// per timeframe, the live last price appended per block, a 1 h series for the 24 h change, refetch on foreground.
// One request per timeframe switch (cached afterwards), never more than one in flight per resolution.
import { candleWindow, type PerplClient } from "@meridian/core/perpl";
import { Store } from "../../../live/store";
import { appendLive, candlesToPoints, MAX_POINTS, type Point } from "./series";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1D";
/** P1 chips (research §5.3); every value is a documented Perpl resolution. */
export const TIMEFRAMES: readonly { key: Timeframe; sec: number }[] = [
  { key: "1m", sec: 60 },
  { key: "5m", sec: 300 },
  { key: "15m", sec: 900 },
  { key: "1h", sec: 3600 },
  { key: "4h", sec: 14400 },
  { key: "1D", sec: 86400 },
];
const secOf = (tf: Timeframe) => TIMEFRAMES.find((t) => t.key === tf)!.sec;
/** 1 h candles kept for the 24 h change: 26 covers "24 h ago" plus the current hour. */
const DAY_COUNT = 26;

export type ChartState = {
  tf: Timeframe;
  points: readonly Point[];
  /** 1 h series (24 h change) */
  day: readonly Point[];
  loading: boolean;
  error: string | undefined;
};

export type ChartFeedDeps = { client: Pick<PerplClient, "getCandles">; marketId: number; priceDecimals: number; now?: () => number };

export class ChartFeed {
  readonly store = new Store<ChartState>({ tf: "15m", points: [], day: [], loading: false, error: undefined });
  private cache = new Map<Timeframe, { points: readonly Point[]; at: number }>();
  private inFlight = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly d: ChartFeedDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Show `tf`: cached points at once, refetched when older than one bucket. */
  setTimeframe(tf: Timeframe): void {
    const c = this.cache.get(tf);
    this.store.update({ tf, points: c?.points ?? [], error: undefined });
    if (!c || this.now() - c.at > secOf(tf) * 1000) void this.load(tf);
  }

  /** Foreground / pull-to-refresh: refetch the shown timeframe and the 1 h series. */
  refresh(): void {
    void this.load(this.store.get().tf);
    void this.loadDay();
  }

  /** One block's live last price: moves the last point or opens the next bucket (shown series + the 1 h series). */
  onLive(priceWad: bigint | undefined): void {
    if (priceWad === undefined) return;
    const s = this.store.get();
    const t = this.now();
    const points = s.points.length ? appendLive(s.points, secOf(s.tf), t, priceWad) : s.points;
    const day = s.day.length ? appendLive(s.day, 3600, t, priceWad) : s.day;
    if (points !== s.points) this.cache.set(s.tf, { points, at: this.cache.get(s.tf)?.at ?? t });
    if (points !== s.points || day !== s.day) this.store.update({ points, day });
  }

  private async load(tf: Timeframe): Promise<void> {
    const sec = secOf(tf);
    if (this.inFlight.has(sec)) return;
    this.inFlight.add(sec);
    if (this.store.get().tf === tf && this.store.get().points.length === 0) this.store.update({ loading: true });
    try {
      const w = candleWindow(sec, this.now(), MAX_POINTS);
      const s = await this.d.client.getCandles(this.d.marketId, sec, w.fromMs, w.toMs);
      const points = candlesToPoints(s.d, this.d.priceDecimals, sec);
      this.cache.set(tf, { points, at: this.now() });
      if (this.store.get().tf === tf) this.store.update({ points, loading: false, error: undefined });
    } catch (e) {
      if (this.store.get().tf === tf) this.store.update({ loading: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.inFlight.delete(sec);
    }
  }

  private async loadDay(): Promise<void> {
    if (this.inFlight.has(-3600)) return;
    this.inFlight.add(-3600);
    try {
      const w = candleWindow(3600, this.now(), DAY_COUNT);
      const s = await this.d.client.getCandles(this.d.marketId, 3600, w.fromMs, w.toMs);
      this.store.update({ day: candlesToPoints(s.d, this.d.priceDecimals, 3600) });
    } catch {
      // the 24 h change shows "—" until the next refresh
    } finally {
      this.inFlight.delete(-3600);
    }
  }
}
