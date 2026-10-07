// Perpl hedge before/after metrics (K3.4, docs/PERPL_HEDGE.md "Measurement"). Pure, unit-tested.
// One sample = Meridian's book (getDepth) + index + the MM's Meridian and Perpl positions at one block.

export type Level = { tick: number; lots: bigint };
export type OneSided = "none" | "bid-only" | "ask-only" | "empty";

export type BookSample = {
  bestBidTick: number | null;
  bestAskTick: number | null;
  /** (ask − bid) / mid in bps, null when one side is empty */
  innerSpreadBps: number | null;
  /** lots resting within ±bandBps of the index, per side */
  bidDepthLots: bigint;
  askDepthLots: bigint;
  oneSided: OneSided;
};

/** Book metrics against the index; prices are tick × tickSize (WAD). Depth band default ±1% (100 bps). */
export function bookMetrics(bids: readonly Level[], asks: readonly Level[], tickSize: bigint, indexWad: bigint, bandBps = 100): BookSample {
  const live = (xs: readonly Level[]) => xs.filter((l) => l.lots > 0n && l.tick > 0);
  const b = live(bids);
  const a = live(asks);
  const bestBid = b.length ? Math.max(...b.map((l) => l.tick)) : null;
  const bestAsk = a.length ? Math.min(...a.map((l) => l.tick)) : null;
  const lo = (indexWad * BigInt(10_000 - bandBps)) / 10_000n;
  const hi = (indexWad * BigInt(10_000 + bandBps)) / 10_000n;
  const px = (t: number) => BigInt(t) * tickSize;
  let innerSpreadBps: number | null = null;
  if (bestBid !== null && bestAsk !== null) {
    const mid2 = px(bestBid) + px(bestAsk);
    innerSpreadBps = Number(((px(bestAsk) - px(bestBid)) * 2n * 1_000_000n) / mid2) / 100; // bps, 2 dp
  }
  return {
    bestBidTick: bestBid,
    bestAskTick: bestAsk,
    innerSpreadBps,
    bidDepthLots: b.filter((l) => px(l.tick) >= lo).reduce((s, l) => s + l.lots, 0n),
    askDepthLots: a.filter((l) => px(l.tick) <= hi).reduce((s, l) => s + l.lots, 0n),
    oneSided: bestBid === null && bestAsk === null ? "empty" : bestBid === null ? "ask-only" : bestAsk === null ? "bid-only" : "none",
  };
}

export type Row = BookSample & { t: number; phase: string; block: bigint; merPosMon: number; perplPosMon: number | null };

/** Nearest-rank percentile of finite numbers; null when empty. */
export function percentile(xs: readonly number[], p: number): number | null {
  const v = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]!;
}
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export type Summary = {
  samples: number;
  spreadP50Bps: number | null;
  spreadMeanBps: number | null;
  bidDepthMeanLots: number | null;
  askDepthMeanLots: number | null;
  oneSidedPct: number;
  absNetDeltaP50Mon: number | null;
  absNetDeltaP90Mon: number | null;
  absNetDeltaMaxMon: number | null;
};

/** Net delta = Meridian + Perpl position (Perpl unknown ⇒ Meridian only, i.e. the hedge-off case). */
export function summarize(rows: readonly Row[]): Summary {
  const spreads = rows.flatMap((r) => (r.innerSpreadBps === null ? [] : [r.innerSpreadBps]));
  const net = rows.map((r) => Math.abs(r.merPosMon + (r.perplPosMon ?? 0)));
  return {
    samples: rows.length,
    spreadP50Bps: percentile(spreads, 50),
    spreadMeanBps: mean(spreads),
    bidDepthMeanLots: mean(rows.map((r) => Number(r.bidDepthLots))),
    askDepthMeanLots: mean(rows.map((r) => Number(r.askDepthLots))),
    oneSidedPct: rows.length ? (100 * rows.filter((r) => r.oneSided !== "none").length) / rows.length : 0,
    absNetDeltaP50Mon: percentile(net, 50),
    absNetDeltaP90Mon: percentile(net, 90),
    absNetDeltaMaxMon: net.length ? Math.max(...net) : null,
  };
}

export const CSV_HEADER = "t,phase,block,bestBidTick,bestAskTick,innerSpreadBps,bidDepthLots,askDepthLots,oneSided,merPosMon,perplPosMon";
export function toCsv(r: Row): string {
  return [r.t, r.phase, r.block, r.bestBidTick ?? "", r.bestAskTick ?? "", r.innerSpreadBps ?? "", r.bidDepthLots, r.askDepthLots, r.oneSided, r.merPosMon, r.perplPosMon ?? ""].join(",");
}
export function fromCsv(line: string): Row {
  const c = line.split(",");
  const n = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));
  return {
    t: Number(c[0]),
    phase: c[1]!,
    block: BigInt(c[2]!),
    bestBidTick: n(c[3]),
    bestAskTick: n(c[4]),
    innerSpreadBps: n(c[5]),
    bidDepthLots: BigInt(c[6]!),
    askDepthLots: BigInt(c[7]!),
    oneSided: c[8] as OneSided,
    merPosMon: Number(c[9]),
    perplPosMon: n(c[10]),
  };
}

export type HedgeCounts = { hedges: number; filled: number; partial: number; noFill: number; rejected: number; unknown: number; perplFills: number };

/** Evidence JSONL (mm-bot HEDGE_EVIDENCE) → counts. */
export function countEvidence(lines: readonly string[]): HedgeCounts {
  const c: HedgeCounts = { hedges: 0, filled: 0, partial: 0, noFill: 0, rejected: 0, unknown: 0, perplFills: 0 };
  for (const l of lines) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { kind: string; outcome?: { os: number; fs: number }; fills?: unknown[]; result?: { kind: string } };
    if (r.kind === "hedge-sent") c.hedges++;
    else if (r.kind === "hedge-outcome" && r.outcome) {
      c.perplFills += r.fills?.length ?? 0;
      if (r.outcome.fs === 0) c.noFill++;
      else if (r.outcome.fs >= r.outcome.os) c.filled++;
      else c.partial++;
    } else if (r.kind === "hedge-rejected" || r.kind === "hedge-not-sent") c.rejected++;
    else if (r.kind === "hedge-unknown") c.unknown++;
  }
  return c;
}

const f = (x: number | null, d = 1) => (x === null ? "–" : x.toFixed(d));
export function markdownTable(off: Summary, on: Summary, counts: { off: HedgeCounts; on: HedgeCounts }): string {
  const rows: [string, string, string][] = [
    ["samples", String(off.samples), String(on.samples)],
    ["Meridian inner spread p50 (bps)", f(off.spreadP50Bps, 2), f(on.spreadP50Bps, 2)],
    ["Meridian inner spread mean (bps)", f(off.spreadMeanBps, 2), f(on.spreadMeanBps, 2)],
    ["depth ±1% bid (lots, mean)", f(off.bidDepthMeanLots), f(on.bidDepthMeanLots)],
    ["depth ±1% ask (lots, mean)", f(off.askDepthMeanLots), f(on.askDepthMeanLots)],
    ["time one-sided (%)", f(off.oneSidedPct), f(on.oneSidedPct)],
    ["|net delta| p50 (MON)", f(off.absNetDeltaP50Mon, 0), f(on.absNetDeltaP50Mon, 0)],
    ["|net delta| p90 (MON)", f(off.absNetDeltaP90Mon, 0), f(on.absNetDeltaP90Mon, 0)],
    ["|net delta| max (MON)", f(off.absNetDeltaMaxMon, 0), f(on.absNetDeltaMaxMon, 0)],
    ["Perpl hedges sent", String(counts.off.hedges), String(counts.on.hedges)],
    ["Perpl fills", String(counts.off.perplFills), String(counts.on.perplFills)],
    ["filled / partial / no fill", `${counts.off.filled} / ${counts.off.partial} / ${counts.off.noFill}`, `${counts.on.filled} / ${counts.on.partial} / ${counts.on.noFill}`],
    ["rejections / unknown", `${counts.off.rejected} / ${counts.off.unknown}`, `${counts.on.rejected} / ${counts.on.unknown}`],
  ];
  return ["| metric | hedge off | hedge on |", "|---|---:|---:|", ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
