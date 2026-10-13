// Incremental eth_getLogs over a sliding window of the last `lookback` blocks.
// Each scan (by key) reads the whole window once, then only the blocks since its last read: the page polls every
// block, and re-reading 2,000 blocks per poll was ~200 eth_getLogs per scan at a 10-block span (Alchemy free tier),
// which put one tab over the provider's rate limit and the public testnet RPC into 429s for everyone.
import { blockRanges } from "./ranges";

export type LogLike = { blockNumber: bigint | null };

export interface LogWindowOptions {
  head: () => Promise<bigint>;
  lookback: bigint;
  span: bigint;
  /** ranges fetched at once (same order kept); the transport batches what lands in the same tick */
  concurrency: number;
  /** blocks below the last read head that are read again, so a log changed at the tip is replaced, not kept */
  overlap?: bigint;
}

export function createLogWindow(o: LogWindowOptions) {
  const overlap = o.overlap ?? 3n;
  const cache = new Map<string, { to: bigint; logs: LogLike[] }>();
  const inflight = new Map<string, Promise<LogLike[]>>();

  async function scan<T extends LogLike>(key: string, fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
    const head = await o.head();
    const start = head > o.lookback ? head - o.lookback : 0n;
    const c = cache.get(key);
    // a node behind the last head we saw (load-balanced RPCs lag each other): serve what we have, read nothing
    if (c && head < c.to) return (c.logs as T[]).filter((l) => l.blockNumber !== null && l.blockNumber >= start);
    // re-read from just below the last head (never before the window); a cold or too-old cache reads the window
    const from = c && c.to + 1n >= start ? (c.to + 1n - overlap > start ? c.to + 1n - overlap : start) : start;
    const ranges = from <= head ? blockRanges(from, head, o.span) : [];
    // kept: cached logs still inside the window and below the re-read range (the re-read replaces the rest)
    const kept = ((c?.logs ?? []) as T[]).filter((l) => l.blockNumber !== null && l.blockNumber >= start && l.blockNumber < from);
    const fresh: T[] = [];
    for (let i = 0; i < ranges.length; i += o.concurrency) {
      let chunk: T[][];
      try {
        chunk = await Promise.all(ranges.slice(i, i + o.concurrency).map(([f, t]) => fetch(f, t)));
      } catch (e) {
        // rate-limited mid-window: keep what was read, so the next call resumes here instead of starting over
        // (a cold 2,000-block window at a 10-block span is 200 calls; restarting it on every 429 never finishes)
        if (i > 0) cache.set(key, { to: ranges[i - 1]![1], logs: [...kept, ...fresh] });
        throw e;
      }
      for (const x of chunk) fresh.push(...x);
    }
    const logs = [...kept, ...fresh];
    cache.set(key, { to: head, logs });
    return logs.slice(); // callers get their own array: the cached one is never sorted or reversed in place
  }

  /** Logs of the last `lookback` blocks for `key`, oldest first. One request per key at a time. */
  return function recent<T extends LogLike>(key: string, fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
    const running = inflight.get(key);
    if (running) return running as Promise<T[]>;
    const p = scan(key, fetch).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
