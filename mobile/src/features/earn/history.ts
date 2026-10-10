// The Earn hero's 24 h sparkline: the funding gap |Meridian − Perpl| (APR) once an hour over the last 24 h, then one live
// point a minute. Perpl: its funding events over 24 h (REST /v1/market-data/:id/funding, core client), the rate in force
// at each hour (core fundingInForce) annualized by core perplRateToAprWad. Meridian: previewFundingState() read AT the
// block ~each hour ago (head − hours · blocks/hour at the measured cadence; block numbers, never timestamps, MATH_SPEC
// §1.1), as an APR of real time (core meridianEffectiveAprWad at today's cadence).
// > VERIFY: Monad RPC serves eth_call 24 h back (archive depth of the configured RPC). Hours it can't read are dropped;
// with < 2 historical points the sparkline is labelled "since you opened Earn" instead of "24 h" (never invented).
import { fundingInForce, perplRateToAprWad, type FundingEvent } from "@meridian/core/perpl";
import { meridianEffectiveAprWad, type BlockCadence } from "@meridian/core/route";
import { abs } from "@meridian/core/util";
import { Store } from "../../live/store";

export type GapPoint = { atMs: number; gapWad: bigint };
export type GapHistoryState = { points: GapPoint[]; span: "24h" | "session" | undefined };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LIVE_EVERY_MS = 60_000;
const MAX_POINTS = 200;

export type MeridianSample = { atMs: number; rateWad: bigint };

/** Pure: one gap point per Meridian sample that has a Perpl rate in force at that time. */
export function gapSeries(o: { perplEvents: readonly FundingEvent[]; perplIntervalSec: number; meridian: readonly MeridianSample[]; paramBlockTimeMs: bigint; cadence: BlockCadence }): GapPoint[] {
  const out: GapPoint[] = [];
  for (const m of o.meridian) {
    const ev = o.perplEvents.filter((e) => e.at.t !== undefined && e.at.t <= m.atMs);
    const p = fundingInForce(ev, m.atMs);
    if (!p || ev.length === 0) continue;
    const gap = meridianEffectiveAprWad(m.rateWad, o.paramBlockTimeMs, o.cadence) - perplRateToAprWad(p.rate, o.perplIntervalSec);
    out.push({ atMs: m.atMs, gapWad: abs(gap) });
  }
  return out;
}

/** Blocks per hour at the measured cadence (rounded down: never reaches past "an hour ago"). */
export const blocksPerHour = (c: BlockCadence): bigint => (c.blocks * BigInt(HOUR_MS)) / c.elapsedMs;

export type GapHistoryDeps = {
  /** previewFundingState().rate at a past block */
  meridianRateAt: (block: bigint) => Promise<bigint>;
  perplFunding: (fromMs: number, toMs: number) => Promise<FundingEvent[]>;
  perplIntervalSec: number;
  now?: () => number;
};

export class GapHistory {
  readonly store = new Store<GapHistoryState>({ points: [], span: undefined });
  private loaded = false;
  private lastLiveMs = -Infinity;
  constructor(private readonly d: GapHistoryDeps) {}

  /** Once per session, when head + cadence + the contract's block time are known. */
  async load(head: bigint, cadence: BlockCadence, paramBlockTimeMs: bigint): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const now = (this.d.now ?? Date.now)();
    const bph = blocksPerHour(cadence);
    let hist: GapPoint[] = [];
    try {
      const events = await this.d.perplFunding(Math.floor(now - DAY_MS - HOUR_MS), Math.floor(now));
      const reads = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) => 24 - i).map(async (h) => ({ atMs: now - h * HOUR_MS, rateWad: await this.d.meridianRateAt(head - BigInt(h) * bph) })),
      );
      const samples = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      hist = gapSeries({ perplEvents: events, perplIntervalSec: this.d.perplIntervalSec, meridian: samples, paramBlockTimeMs, cadence });
    } catch {
      // no history: live points only
    }
    const cur = this.store.get().points;
    this.store.set({ points: [...hist, ...cur].slice(-MAX_POINTS), span: hist.length >= 2 ? "24h" : "session" });
  }

  /** The live gap (per block from the screen); kept once a minute, 24 h window. */
  onLive(gapWad: bigint | undefined): void {
    const now = (this.d.now ?? Date.now)();
    if (gapWad === undefined || now - this.lastLiveMs < LIVE_EVERY_MS) return;
    this.lastLiveMs = now;
    const s = this.store.get();
    const points = [...s.points, { atMs: now, gapWad: abs(gapWad) }].filter((p) => p.atMs >= now - DAY_MS).slice(-MAX_POINTS);
    this.store.set({ points, span: s.span ?? "session" });
  }
}
