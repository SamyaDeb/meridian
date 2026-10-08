import { BlockSource, isRateLimited, MAX_BACKOFF_MS, nextBackoffMs, errText, type Timer } from "../live/blockStore";

/** Deterministic timer: manual clock + task queue. */
function fakeTimer() {
  let now = 1_000_000;
  let id = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const t: Timer & { advance(ms: number): Promise<void>; pending(): number[] } = {
    now: () => now,
    set: (fn, ms) => {
      tasks.set(++id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void tasks.delete(h as number),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        tasks.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => [...tasks.values()].map((v) => v.at - now),
  };
  return t;
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("BlockSource (poll)", () => {
  it("polls every 400 ms, records the head and measures the cadence", async () => {
    const timer = fakeTimer();
    let head = 100n;
    const src = new BlockSource({ getBlockNumber: async () => head++, timer });
    src.start();
    await flush();
    expect(src.store.get().block).toBe(100n);
    expect(src.store.get().liveness).toBe("live");
    await timer.advance(400);
    await timer.advance(400);
    const s = src.store.get();
    expect(s.block).toBe(102n);
    expect(s.cadence).toEqual({ blocks: 2n, elapsedMs: 800n });
  });

  it("backs off on 429 (1 s, 2 s, 4 s … capped) and recovers", async () => {
    const timer = fakeTimer();
    let fail = 3;
    const src = new BlockSource({
      getBlockNumber: async () => {
        if (fail-- > 0) throw Object.assign(new Error("HTTP request failed. Status: 429 URL: https://rpc.example.invalid/secret"), { status: 429 });
        return 7n;
      },
      timer,
    });
    src.start();
    await flush();
    expect(src.store.get().backoffMs).toBe(1_000);
    expect(src.store.get().lastError).not.toMatch(/secret|https/);
    await timer.advance(1_000);
    expect(src.store.get().backoffMs).toBe(2_000);
    await timer.advance(2_000);
    expect(src.store.get().backoffMs).toBe(4_000);
    await timer.advance(4_000);
    expect(src.store.get()).toMatchObject({ block: 7n, backoffMs: 0, failures: 0 });
  });

  it("pause stops polling; resume refetches immediately", async () => {
    const timer = fakeTimer();
    const calls: number[] = [];
    let head = 1n;
    const src = new BlockSource({ getBlockNumber: async () => (calls.push(timer.now()), head++), timer });
    src.start();
    await flush();
    src.stop();
    const n = calls.length;
    await timer.advance(5_000);
    expect(calls.length).toBe(n);
    expect(src.store.get().running).toBe(false);
    src.start();
    await flush();
    expect(calls.length).toBe(n + 1);
    expect(src.store.get().block).toBe(2n);
  });

  it("ignores a late result from before a pause", async () => {
    const timer = fakeTimer();
    let resolve!: (b: bigint) => void;
    const src = new BlockSource({ getBlockNumber: () => new Promise((r) => (resolve = r)), timer });
    src.start();
    src.stop();
    resolve(99n);
    await flush();
    expect(src.store.get().block).toBeUndefined();
  });

  it("goes stale after 3 s without a new block, live again on the next one", async () => {
    const timer = fakeTimer();
    const src = new BlockSource({ getBlockNumber: async () => 5n, timer });
    src.start();
    await flush();
    await timer.advance(3_600);
    expect(src.store.get().liveness).toBe("stale");
    src.observe(6n);
    expect(src.store.get().liveness).toBe("live");
  });

  it("uses the WS subscription when given, falls back to polling on error", async () => {
    const timer = fakeTimer();
    let push!: (b: bigint) => void;
    let fail!: (e: unknown) => void;
    const polls: number[] = [];
    const src = new BlockSource({ getBlockNumber: async () => (polls.push(1), 10n), subscribeHeads: (onB, onE) => ((push = onB), (fail = onE), () => undefined), timer });
    src.start();
    await flush();
    expect(src.store.get().source).toBe("ws");
    push(11n);
    push(12n);
    expect(src.store.get().block).toBe(12n);
    const p = polls.length;
    await timer.advance(2_000);
    expect(polls.length).toBe(p); // no polling while the socket works
    fail(new Error("socket closed"));
    expect(src.store.get().source).toBe("poll");
    await timer.advance(400);
    expect(polls.length).toBe(p + 1);
  });
});

describe("helpers", () => {
  it("isRateLimited finds 429 in status, message or cause", () => {
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimited({ cause: { status: 429 } })).toBe(true);
    expect(isRateLimited(new Error("execution reverted"))).toBe(false);
  });
  it("nextBackoffMs doubles and caps", () => {
    expect(nextBackoffMs(0, true, 400)).toBe(1_000);
    expect(nextBackoffMs(0, false, 400)).toBe(400);
    expect(nextBackoffMs(8_000, true, 400)).toBe(MAX_BACKOFF_MS);
  });
  it("errText strips URLs (they can carry an RPC key)", () => {
    expect(errText(new Error("failed: https://rpc.example.invalid/v1/KEY123 and wss://x.invalid/a\nstack"))).toBe("failed: <url> and <url>");
  });
});
