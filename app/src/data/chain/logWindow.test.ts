import { describe, expect, it } from "vitest";
import { createLogWindow } from "./logWindow";

type L = { blockNumber: bigint; tag: string };
// a fake chain: one log per block, tagged so a re-read (tip change) is visible
function setup(o: { lookback?: bigint; span?: bigint; overlap?: bigint } = {}) {
  let head = 100n;
  let tag = "a";
  const calls: Array<[bigint, bigint]> = [];
  const fetch = async (f: bigint, t: bigint): Promise<L[]> => {
    calls.push([f, t]);
    const out: L[] = [];
    for (let b = f; b <= t; b++) out.push({ blockNumber: b, tag });
    return out;
  };
  const recent = createLogWindow({ head: async () => head, lookback: o.lookback ?? 20n, span: o.span ?? 10n, concurrency: 2, ...(o.overlap !== undefined ? { overlap: o.overlap } : {}) });
  return { recent, fetch, calls, setHead: (h: bigint) => (head = h), setTag: (t: string) => (tag = t) };
}

describe("createLogWindow (incremental eth_getLogs)", () => {
  it("first call reads the whole window in span-sized ranges", async () => {
    const w = setup();
    const logs = await w.recent("k", w.fetch);
    expect(logs.map((l) => l.blockNumber)).toEqual(Array.from({ length: 21 }, (_, i) => 80n + BigInt(i)));
    expect(w.calls).toEqual([[80n, 89n], [90n, 99n], [100n, 100n]]);
  });
  it("later calls read only new blocks plus the overlap, and drop blocks that left the window", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.calls.length = 0;
    w.setHead(105n);
    const logs = await w.recent("k", w.fetch);
    expect(w.calls).toEqual([[98n, 105n]]); // 3-block overlap below the last head (100)
    expect(logs[0]!.blockNumber).toBe(85n);
    expect(logs.at(-1)!.blockNumber).toBe(105n);
    expect(new Set(logs.map((l) => l.blockNumber)).size).toBe(logs.length); // no duplicates
  });
  it("the overlap replaces logs at the tip (a changed block is not kept twice or stale)", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.setTag("b");
    w.setHead(101n);
    const logs = await w.recent("k", w.fetch);
    expect(logs.filter((l) => l.blockNumber >= 98n).every((l) => l.tag === "b")).toBe(true);
    expect(logs.filter((l) => l.blockNumber < 98n).every((l) => l.tag === "a")).toBe(true);
  });
  it("same head again: only the overlap is re-read", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.calls.length = 0;
    await w.recent("k", w.fetch);
    expect(w.calls).toEqual([[98n, 100n]]);
  });
  it("a cache older than the window reads the full window again", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.calls.length = 0;
    w.setHead(500n);
    const logs = await w.recent("k", w.fetch);
    expect(w.calls[0]).toEqual([480n, 489n]);
    expect(logs.length).toBe(21);
  });
  it("a lagging node (head behind the last one) reads nothing and serves the cache", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.calls.length = 0;
    w.setHead(99n);
    const logs = await w.recent("k", w.fetch);
    expect(w.calls).toEqual([]);
    expect(logs.at(-1)!.blockNumber).toBe(100n);
  });
  it("keys are independent; concurrent calls on one key share a single read", async () => {
    const w = setup();
    const [a, b] = await Promise.all([w.recent("k", w.fetch), w.recent("k", w.fetch)]);
    expect(a).toEqual(b);
    expect(w.calls.length).toBe(3);
    await w.recent("other", w.fetch);
    expect(w.calls.length).toBe(6);
  });
  it("returns a copy: mutating the result never touches the cache", async () => {
    const w = setup();
    (await w.recent("k", w.fetch)).reverse();
    w.calls.length = 0;
    const logs = await w.recent("k", w.fetch);
    expect(logs[0]!.blockNumber).toBe(80n);
  });
  it("a failed read leaves the previous cache and lets the next call retry", async () => {
    const w = setup();
    await w.recent("k", w.fetch);
    w.setHead(103n);
    await expect(w.recent("k", async () => Promise.reject(new Error("429")))).rejects.toThrow("429");
    const logs = await w.recent("k", w.fetch);
    expect(logs.at(-1)!.blockNumber).toBe(103n);
    expect(logs.length).toBe(21);
  });
  it("a read that fails mid-window keeps the ranges it got: the next call resumes, it does not start over", async () => {
    const w = setup({ lookback: 50n });
    let n = 0;
    const flaky = async (f: bigint, t: bigint) => {
      if (++n > 2) throw new Error("429");
      return w.fetch(f, t);
    };
    await expect(w.recent("k", flaky)).rejects.toThrow("429"); // got [50,59] and [60,69] (concurrency 2), then 429
    w.calls.length = 0;
    const logs = await w.recent("k", w.fetch);
    expect(w.calls[0]).toEqual([67n, 76n]); // resumes below 69 (3-block overlap), not at 50
    expect(logs.map((l) => l.blockNumber)).toEqual(Array.from({ length: 51 }, (_, i) => 50n + BigInt(i)));
  });
});
