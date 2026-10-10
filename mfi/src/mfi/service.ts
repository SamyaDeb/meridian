// One MFI cycle every 60 s: read both venues, apply staleness (MFI.md §5), compute (§4), keep bounded history (§9 option A).
import type { MeridianRead } from "../meridian/read";
import { PerplSchemaError, PerplUnavailableError } from "../perpl/errors";
import type { PerplVenueRead } from "../perpl/client";
import type { PerplFees } from "../perpl/types";
import { MinOiWindow, computeMfi, type VenueId, type VenueInput, type VenueStatus, type Weighting } from "./compute";

export type VenueView = {
  id: VenueId;
  included: boolean;
  status: VenueStatus;
  reason?: string;
  aprWad?: string;
  oiNotionalWad?: string;
  weightOiWad?: string;
  weightBps?: number;
  // meridian
  windowBlocks?: number;
  asOfBlock?: string;
  // perpl
  marketId?: number;
  fundingIntervalSec?: number;
  rateMicros?: number;
  fundingEventBlock?: number;
  asOfMs?: number;
  /** perpl: where this read came from (market-data WebSocket, or the REST fallback) */
  source?: "ws" | "rest";
};

/** Fees per venue as a fraction of notional in WAD (Perpl micros × 1e12; Meridian RiskParams as is). Display data. */
export type FeesView = {
  meridian?: { takerWad: string; makerWad: string };
  perpl?: { takerWad: string; makerWad: string; takerMicros: number; makerMicros: number };
};

/** APR_meridian − APR_perpl, annualized WAD (exact: a difference of two neutral-rounded rates). Both venues must be included. */
export type SpreadView = { aprWad: string; meridianAprWad: string; perplAprWad: string };

export type Snapshot = {
  version: "mfi-v0";
  chainId: number;
  index: { aprWad: string; weighting: Weighting } | null;
  stale: boolean;
  warmup: boolean;
  updatedBlock: string | null;
  updatedAt: number;
  venuesIncluded: VenueId[];
  venues: VenueView[];
  /** null unless both venues are included this cycle */
  spread: SpreadView | null;
  fees: FeesView;
};

export type HistoryPoint = {
  updatedBlock: string | null;
  updatedAt: number;
  aprWad: string | null;
  meridianAprWad: string | null;
  perplAprWad: string | null;
  venuesIncluded: VenueId[];
  stale: boolean;
};

export type ServiceConfig = {
  chainId: number;
  /** Perpl funding older than interval + this ⇒ stale (MFI.md §5) */
  perplFundingGraceMs?: number;
  /** Perpl ticker older than this ⇒ stale */
  perplStateMaxAgeMs?: number;
  /** response stale when the newest included input is older than this */
  maxAgeMs?: number;
  historyMax?: number;
  /** history older than this is dropped (MFI.md §9: 7 days) */
  historyRetentionMs?: number;
  /** points loaded from disk on start (oldest first) */
  initialHistory?: readonly HistoryPoint[];
  /** called with every new point (JSONL append, decision D7) */
  onHistoryPoint?: (p: HistoryPoint, retained: () => readonly HistoryPoint[]) => void;
};

export type CycleInputs = { nowMs: number; meridian: MeridianRead; perpl: { ok: true; read: PerplVenueRead & { source?: "ws" | "rest" } } | { ok: false; error: unknown } };

/** Perpl micros (10^-6) → WAD fraction. Exact. */
const microsToWad = (m: number) => BigInt(m) * 10n ** 12n;

/** History point → spread point (derived, so points stored before the spread route existed still serve). */
export type SpreadPoint = { updatedBlock: string | null; updatedAt: number; spreadAprWad: string; meridianAprWad: string; perplAprWad: string };
export function spreadOf(p: HistoryPoint): SpreadPoint | undefined {
  if (p.meridianAprWad === null || p.perplAprWad === null) return undefined;
  return { updatedBlock: p.updatedBlock, updatedAt: p.updatedAt, spreadAprWad: (BigInt(p.meridianAprWad) - BigInt(p.perplAprWad)).toString(), meridianAprWad: p.meridianAprWad, perplAprWad: p.perplAprWad };
}

export function perplFailure(e: unknown): { status: VenueStatus; reason: string } {
  if (e instanceof PerplSchemaError) return { status: "invalid", reason: e.message };
  if (e instanceof PerplUnavailableError) return { status: "unavailable", reason: `${e.kind}: ${e.message}` };
  return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
}

export class MfiService {
  private readonly oi = { meridian: new MinOiWindow(), perpl: new MinOiWindow() };
  private readonly history: HistoryPoint[] = [];
  private last: Snapshot | undefined;
  private lastGood: { index: NonNullable<Snapshot["index"]>; updatedAt: number; updatedBlock: string | null } | undefined;
  private fees: FeesView = {};
  private readonly cfg: Required<Omit<ServiceConfig, "initialHistory" | "onHistoryPoint">>;
  private readonly onHistoryPoint: ServiceConfig["onHistoryPoint"];

  constructor({ initialHistory, onHistoryPoint, ...cfg }: ServiceConfig) {
    this.cfg = { perplFundingGraceMs: 120_000, perplStateMaxAgeMs: 120_000, maxAgeMs: 120_000, historyMax: 10_080, historyRetentionMs: 7 * 24 * 3600 * 1000, ...cfg };
    this.onHistoryPoint = onHistoryPoint;
    if (initialHistory) this.history.push(...initialHistory.slice(-this.cfg.historyMax));
  }

  current(): Snapshot | undefined {
    return this.last;
  }

  /** Spread points (both venues included), oldest first, within [fromMs, toMs], newest `limit` points. */
  spreadRange(fromMs: number, toMs: number, limit: number): SpreadPoint[] {
    return this.history
      .filter((p) => p.updatedAt >= fromMs && p.updatedAt <= toMs)
      .flatMap((p) => spreadOf(p) ?? [])
      .slice(-limit);
  }

  /** History, oldest first, within [fromMs, toMs], newest `limit` points. */
  historyRange(fromMs: number, toMs: number, limit: number): HistoryPoint[] {
    return this.history.filter((p) => p.updatedAt >= fromMs && p.updatedAt <= toMs).slice(-limit);
  }

  /** Re-runs a cycle with fresh inputs; returns the snapshot it now serves. */
  cycle(inp: CycleInputs): Snapshot {
    const { nowMs } = inp;
    const views: VenueView[] = [];
    const inputs: VenueInput[] = [];

    // Meridian
    const m = inp.meridian;
    if (m.ok && m.fees) this.fees = { ...this.fees, meridian: { takerWad: m.fees.takerWad.toString(), makerWad: m.fees.makerWad.toString() } };
    if (inp.perpl.ok && inp.perpl.read.fees) this.fees = { ...this.fees, perpl: perplFeesView(inp.perpl.read.fees) };
    if (m.ok) {
      this.oi.meridian.add(nowMs, m.oiNotionalWad);
      const w = this.oi.meridian.min(nowMs);
      inputs.push({ id: "meridian", status: "ok", aprWad: m.aprWad, ...(w !== undefined ? { weightOiWad: w } : {}) });
      views.push({ id: "meridian", included: true, status: "ok", aprWad: m.aprWad.toString(), oiNotionalWad: m.oiNotionalWad.toString(), ...(w !== undefined ? { weightOiWad: w.toString() } : {}), windowBlocks: Number(m.windowBlocks), asOfBlock: m.asOfBlock.toString(), asOfMs: nowMs });
    } else {
      inputs.push({ id: "meridian", status: m.status, reason: m.reason });
      views.push({ id: "meridian", included: false, status: m.status, reason: m.reason });
    }

    // Perpl
    if (inp.perpl.ok) {
      const p = inp.perpl.read;
      const fundingAge = p.fundingAtMs === undefined ? Infinity : nowMs - p.fundingAtMs;
      const stateAge = p.stateAtMs === undefined ? Infinity : nowMs - p.stateAtMs;
      const base: VenueView = { id: "perpl", included: false, status: "ok", aprWad: p.aprWad.toString(), oiNotionalWad: p.oiNotionalWad.toString(), marketId: p.marketId, fundingIntervalSec: p.fundingIntervalSec, rateMicros: p.rateMicros, fundingEventBlock: p.fundingEventBlock, ...(p.stateAtMs !== undefined ? { asOfMs: p.stateAtMs } : {}), ...(p.source ? { source: p.source } : {}) };
      let stale: string | undefined;
      if (fundingAge > p.fundingIntervalSec * 1000 + this.cfg.perplFundingGraceMs) stale = `funding event ${fundingAge} ms old`;
      else if (stateAge > this.cfg.perplStateMaxAgeMs) stale = `ticker ${stateAge} ms old`;
      if (stale) {
        inputs.push({ id: "perpl", status: "stale", reason: stale });
        views.push({ ...base, status: "stale", reason: stale });
      } else {
        this.oi.perpl.add(nowMs, p.oiNotionalWad);
        const w = this.oi.perpl.min(nowMs);
        inputs.push({ id: "perpl", status: "ok", aprWad: p.aprWad, ...(w !== undefined ? { weightOiWad: w } : {}) });
        views.push({ ...base, included: true, ...(w !== undefined ? { weightOiWad: w.toString() } : {}) });
      }
    } else {
      const f = perplFailure(inp.perpl.error);
      inputs.push({ id: "perpl", status: f.status, reason: f.reason });
      views.push({ id: "perpl", included: false, status: f.status, reason: f.reason });
    }

    const r = computeMfi(inputs);
    for (const v of views) {
      const bps = r.weightBps[v.id];
      if (bps !== undefined) v.weightBps = bps;
    }
    const updatedBlock = m.ok ? m.headBlock.toString() : m.headBlock !== undefined ? m.headBlock.toString() : null;
    const warmup = r.included.some((id) => this.oi[id].warmup(nowMs));
    const aprOf = (id: VenueId) => views.find((v) => v.id === id && v.included)?.aprWad ?? null;
    const mApr = aprOf("meridian");
    const pApr = aprOf("perpl");
    // MFI.md §4.4: rounds neutral; a difference of two already-rounded integers is exact
    const spread = mApr !== null && pApr !== null ? { aprWad: (BigInt(mApr) - BigInt(pApr)).toString(), meridianAprWad: mApr, perplAprWad: pApr } : null;
    const extra = { spread, fees: this.fees };
    let snap: Snapshot;
    if (r.aprWad !== null) {
      const index = { aprWad: r.aprWad.toString(), weighting: r.weighting };
      this.lastGood = { index, updatedAt: nowMs, updatedBlock };
      snap = { version: "mfi-v0", chainId: this.cfg.chainId, index, stale: false, warmup, updatedBlock, updatedAt: nowMs, venuesIncluded: r.included, venues: views, ...extra };
    } else {
      // nothing fresh: keep the last good value, flagged stale, with ITS timestamp (MFI.md §5)
      const lg = this.lastGood;
      snap = { version: "mfi-v0", chainId: this.cfg.chainId, index: lg?.index ?? null, stale: true, warmup, updatedBlock: lg?.updatedBlock ?? updatedBlock, updatedAt: lg?.updatedAt ?? nowMs, venuesIncluded: [], venues: views, ...extra };
    }
    this.last = snap;
    const point: HistoryPoint = { updatedBlock, updatedAt: nowMs, aprWad: r.aprWad?.toString() ?? null, meridianAprWad: mApr, perplAprWad: pApr, venuesIncluded: r.included, stale: r.aprWad === null };
    this.history.push(point);
    if (this.history.length > this.cfg.historyMax) this.history.splice(0, this.history.length - this.cfg.historyMax);
    const cutoff = nowMs - this.cfg.historyRetentionMs;
    const old = this.history.findIndex((p) => p.updatedAt >= cutoff);
    if (old > 0) this.history.splice(0, old);
    this.onHistoryPoint?.(point, () => this.history);
    return snap;
  }

  /** `stale` as served at `nowMs`: a snapshot older than maxAgeMs is stale even if it was fresh when computed. */
  served(nowMs: number): Snapshot | undefined {
    const s = this.last;
    if (!s) return undefined;
    return nowMs - s.updatedAt > this.cfg.maxAgeMs ? { ...s, stale: true } : s;
  }
}

function perplFeesView(f: PerplFees): NonNullable<FeesView["perpl"]> {
  return { takerWad: microsToWad(f.takerMicros).toString(), makerWad: microsToWad(f.makerMicros).toString(), takerMicros: f.takerMicros, makerMicros: f.makerMicros };
}
