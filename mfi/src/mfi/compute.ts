// MFI arithmetic (docs/MFI.md §4). Pure, bigint only. Every division truncates toward zero ("rounds neutral", §4.4).
export type VenueId = "meridian" | "perpl";
export type VenueStatus = "ok" | "stale" | "unavailable" | "invalid" | "oracle-stale";

export type VenueInput = {
  id: VenueId;
  status: VenueStatus;
  reason?: string;
  /** annualized WAD rate (MFI.md §3) */
  aprWad?: bigint;
  /** weight input: 1 h minimum OI notional, quote WAD (MFI.md §4.1) */
  weightOiWad?: bigint;
};

export type Weighting = "oi" | "equal" | "none";

export type MfiResult = {
  aprWad: bigint | null;
  weighting: Weighting;
  included: VenueId[];
  /** floor(OI_v · 10_000 / Σ OI); display only, may sum to 9,999. Absent ⇒ venue not included */
  weightBps: Partial<Record<VenueId, number>>;
};

/** MFI.md §4.2. A venue is included only with status "ok" and an APR. */
export function computeMfi(venues: VenueInput[]): MfiResult {
  const live = venues.filter((v): v is VenueInput & { aprWad: bigint } => v.status === "ok" && v.aprWad !== undefined);
  if (live.length === 0) return { aprWad: null, weighting: "none", included: [], weightBps: {} };
  const oi = (v: VenueInput) => (v.weightOiWad !== undefined && v.weightOiWad > 0n ? v.weightOiWad : 0n);
  const total = live.reduce((s, v) => s + oi(v), 0n);
  const included = live.map((v) => v.id);
  if (total === 0n) {
    const weightBps = Object.fromEntries(live.map((v) => [v.id, Math.floor(10_000 / live.length)]));
    return { aprWad: live.reduce((s, v) => s + v.aprWad, 0n) / BigInt(live.length), weighting: "equal", included, weightBps };
  }
  const weightBps = Object.fromEntries(live.map((v) => [v.id, Number((oi(v) * 10_000n) / total)]));
  return { aprWad: live.reduce((s, v) => s + oi(v) * v.aprWad, 0n) / total, weighting: "oi", included, weightBps };
}

/** Bounded per-venue OI sample window; weight = min over the last `windowMs` (MFI.md §4.1, §6.3). */
export class MinOiWindow {
  private samples: { atMs: number; oiWad: bigint }[] = [];
  constructor(
    private readonly windowMs = 3_600_000,
    private readonly maxSamples = 120,
  ) {}
  add(atMs: number, oiWad: bigint): void {
    this.samples.push({ atMs, oiWad });
    this.samples = this.samples.filter((s) => s.atMs > atMs - this.windowMs).slice(-this.maxSamples);
  }
  /** min OI over the window ending at `nowMs`; undefined if empty */
  min(nowMs: number): bigint | undefined {
    let m: bigint | undefined;
    for (const s of this.samples) if (s.atMs > nowMs - this.windowMs && s.atMs <= nowMs && (m === undefined || s.oiWad < m)) m = s.oiWad;
    return m;
  }
  /** true until the oldest sample is a full window old */
  warmup(nowMs: number): boolean {
    const first = this.samples[0];
    return !first || nowMs - first.atMs < this.windowMs - 60_000;
  }
}
