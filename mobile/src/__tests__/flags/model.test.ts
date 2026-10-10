// Remote flags (features/flags): the /api/flags contract, the version compare, the fail-safe policy table and every open
// gate; plus the reader (start, foreground, 60 s while active, last good value in KV) on fakes, no network.
import { flagsKey } from "../../features/flags/client";
import { DEFAULT_FLAGS, opensBlocked, PAUSED_TEXT, parseFlags, resolveFlags, STALE_MS, STATUS_UNKNOWN, UPDATE_TEXT, versionBelow, type FlagsView, type OpenKind } from "../../features/flags/model";
import { OrderLock } from "../../features/trade/exec/orderLock";
import { fakeFlags, memKv } from "./flagsFixtures";

const H = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("parseFlags", () => {
  it("accepts the web route's shape (app/src/lib/flags.ts) and nothing else", () => {
    expect(parseFlags(DEFAULT_FLAGS)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags({ ...DEFAULT_FLAGS, message: "  back soon " })).toEqual({ ...DEFAULT_FLAGS, message: "back soon" });
    for (const bad of [null, "x", { ...DEFAULT_FLAGS, v: 2 }, { ...DEFAULT_FLAGS, writes: "false" }, { ...DEFAULT_FLAGS, lock: undefined }, { ...DEFAULT_FLAGS, minAppVersion: "1" }]) expect(parseFlags(bad)).toBeUndefined();
  });
});

describe("versionBelow", () => {
  it.each([
    ["0.1.0", "0.2.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.10.0", "0.9.9", false], // numeric, not lexical
    ["0.9.9", "0.10.0", true],
    ["1.0.0", "0.99.99", false],
    ["0.2.0", "0.2.1", true],
    ["0.2.0", "0.0.0", false],
  ])("%s < %s ⇒ %s", (a, b, want) => expect(versionBelow(a, b)).toBe(want));
  it("an unknown or odd version never locks anyone out", () => {
    expect(versionBelow(undefined, "9.9.9")).toBe(false);
    expect(versionBelow("—", "9.9.9")).toBe(false);
    expect(versionBelow("0.2.0-rc.1", "9.9.9")).toBe(false);
  });
});

describe("fail-safe policy (fresh / stale / unknown × env)", () => {
  const off = { ...DEFAULT_FLAGS, writes: false };
  const fresh = { flags: off, atMs: NOW - 23 * H };
  const stale = { flags: off, atMs: NOW - 25 * H };
  const rows: [string, Parameters<typeof resolveFlags>[0]["live"], Parameters<typeof resolveFlags>[0]["last"], "development" | "staging" | "production", FlagsView["source"], boolean, string | undefined][] = [
    // label, live read, last good, env → source, writes, status line
    ["read now", off, undefined, "production", "live", false, undefined],
    ["read now beats the cache", DEFAULT_FLAGS, fresh, "production", "live", true, undefined],
    ["unreachable, last good < 24 h (staging)", undefined, fresh, "staging", "cached", false, undefined],
    ["unreachable, last good < 24 h (production)", undefined, fresh, "production", "cached", false, undefined],
    ["unreachable, last good > 24 h (staging)", undefined, stale, "staging", "default", true, undefined],
    ["unreachable, last good > 24 h (production)", undefined, stale, "production", "default", true, STATUS_UNKNOWN],
    ["unknown, nothing stored (development)", undefined, undefined, "development", "default", true, undefined],
    ["unknown, nothing stored (production)", undefined, undefined, "production", "default", true, STATUS_UNKNOWN],
  ];
  it.each(rows)("%s", (_l, live, last, env, source, writes, line) => {
    const v = resolveFlags({ live, last, nowMs: NOW, env, appVersion: "0.2.0" });
    expect(v.source).toBe(source);
    expect(v.flags.writes).toBe(writes);
    expect(v.statusLine).toBe(line);
    // the status line never blocks: opens stay allowed on production with unknown flags
    if (line) expect(opensBlocked("trade-meridian", v)).toBeUndefined();
  });
  it("exactly 24 h old is stale; a clock that went backwards doesn't trust the cache", () => {
    expect(resolveFlags({ live: undefined, last: { flags: off, atMs: NOW - STALE_MS }, nowMs: NOW, env: "staging", appVersion: undefined }).source).toBe("default");
    expect(resolveFlags({ live: undefined, last: { flags: off, atMs: NOW + H }, nowMs: NOW, env: "staging", appVersion: undefined }).source).toBe("default");
  });
  it("forced update follows the flags in use (live or cached), never the defaults", () => {
    const min = { ...DEFAULT_FLAGS, minAppVersion: "0.3.0" };
    expect(resolveFlags({ live: min, last: undefined, nowMs: NOW, env: "production", appVersion: "0.2.0" }).updateRequired).toBe(true);
    expect(resolveFlags({ live: undefined, last: { flags: min, atMs: NOW - H }, nowMs: NOW, env: "production", appVersion: "0.2.0" }).updateRequired).toBe(true);
    expect(resolveFlags({ live: min, last: undefined, nowMs: NOW, env: "production", appVersion: "0.3.0" }).updateRequired).toBe(false);
    expect(resolveFlags({ live: undefined, last: undefined, nowMs: NOW, env: "production", appVersion: "0.0.1" }).updateRequired).toBe(false);
  });
});

describe("opensBlocked: every open entry point", () => {
  const v = (f: Partial<typeof DEFAULT_FLAGS>, updateRequired = false): FlagsView => ({ flags: { ...DEFAULT_FLAGS, ...f }, source: "live", atMs: NOW, statusLine: undefined, updateRequired });
  const ALL: OpenKind[] = ["trade-meridian", "trade-perpl", "earn", "lock", "perpl-setup"];
  const blockedBy = (view: FlagsView) => ALL.filter((k) => opensBlocked(k, view) !== undefined);

  it("all on ⇒ nothing blocked", () => expect(blockedBy(v({}))).toEqual([]));
  it("writes off ⇒ every open, with the flag's message or the default line", () => {
    expect(blockedBy(v({ writes: false }))).toEqual(ALL);
    expect(opensBlocked("earn", v({ writes: false }))).toBe(PAUSED_TEXT);
    expect(opensBlocked("trade-perpl", v({ writes: false, message: "Back at 14:00 UTC" }))).toBe("Back at 14:00 UTC");
  });
  it("perpl off ⇒ Perpl opens + Perpl setup + Earn (it opens a Perpl leg) + Lock; Meridian trades still open", () => {
    expect(blockedBy(v({ perpl: false }))).toEqual(["trade-perpl", "earn", "lock", "perpl-setup"]);
  });
  it("earn off ⇒ Earn (and its Lock) only", () => expect(blockedBy(v({ earn: false }))).toEqual(["earn", "lock"]));
  it("lock off ⇒ the Lock toggle only (Earn still opens at the floating rate)", () => {
    expect(blockedBy(v({ lock: false }))).toEqual(["lock"]);
    expect(opensBlocked("lock", v({ lock: false }))).toMatch(/floating rate/);
  });
  it("forced update ⇒ every open, with the update line", () => {
    expect(blockedBy(v({}, true))).toEqual(ALL);
    expect(opensBlocked("trade-meridian", v({}, true))).toBe(UPDATE_TEXT);
  });
});

describe("OrderLock.opensBlocked sits next to blocked(); closes and resume never ask it", () => {
  it("delegates to the flags gate; unset ⇒ allowed", () => {
    const lock = new OrderLock();
    expect(lock.opensBlocked("earn")).toBeUndefined();
    lock.setOpensGate((k) => (k === "earn" ? "paused" : undefined));
    expect(lock.opensBlocked("earn")).toBe("paused");
    expect(lock.opensBlocked("trade-meridian")).toBeUndefined();
  });
  it("with every open refused, blocked() (what Close all / Earn close / single close ask) and resume still go through", async () => {
    const lock = new OrderLock();
    lock.setOpensGate(() => PAUSED_TEXT);
    const resumed: string[] = [];
    lock.register("single", { busy: () => false, resume: async () => void resumed.push("single") });
    lock.register("closeAll", { busy: () => false, resume: async () => void resumed.push("closeAll") });
    lock.register("earn", { busy: () => false, resume: async () => void resumed.push("earn") });
    expect(lock.blocked("single")).toBeUndefined();
    expect(lock.blocked("closeAll")).toBeUndefined();
    expect(lock.blocked("earn")).toBeUndefined();
    await lock.resume();
    expect(resumed).toEqual(["single", "closeAll", "earn"]);
  });
});

describe("FlagsClient", () => {
  afterEach(() => jest.useRealTimers());

  it("reads ${webUrl}/api/flags, publishes live flags and keeps the last good value with its time", async () => {
    const f = fakeFlags({ flags: { writes: false }, now: () => NOW });
    await f.client.refresh();
    expect(f.calls).toEqual(["https://meridian-testnet.vercel.app/api/flags"]);
    expect(f.client.store.get()).toMatchObject({ source: "live", atMs: NOW, flags: { writes: false } });
    expect(JSON.parse(f.kv.map.get(flagsKey("staging"))!)).toEqual({ flags: { ...DEFAULT_FLAGS, writes: false }, atMs: NOW });
  });

  it("unreachable ⇒ the stored value while < 24 h old, then the defaults (production: the status line)", async () => {
    let now = NOW;
    const kv = memKv();
    const a = fakeFlags({ flags: { writes: false }, env: "production", webUrl: "https://example.test", kv, now: () => now });
    await a.client.refresh();
    // a relaunch: a new client, endpoint down
    const b = fakeFlags({ env: "production", webUrl: "https://example.test", kv, now: () => now });
    b.fail();
    now += 23 * H;
    await b.client.refresh();
    expect(b.client.store.get()).toMatchObject({ source: "cached", flags: { writes: false }, statusLine: undefined });
    now += 2 * H;
    await b.client.refresh();
    expect(b.client.store.get()).toMatchObject({ source: "default", flags: { writes: true }, statusLine: STATUS_UNKNOWN });
  });

  it("a body that isn't flags counts as unreachable (stored value untouched)", async () => {
    const f = fakeFlags({ now: () => NOW });
    await f.client.refresh();
    f.raw({ hello: "world" });
    await f.client.refresh();
    expect(f.client.store.get().source).toBe("cached");
  });

  it("production with no web URL yet (until N9): unknown, never fetched, opens allowed + status line", async () => {
    const f = fakeFlags({ env: "production", webUrl: undefined });
    await f.client.refresh();
    expect(f.calls).toEqual([]);
    expect(f.client.store.get()).toMatchObject({ source: "default", statusLine: STATUS_UNKNOWN });
    expect(opensBlocked("trade-perpl", f.client.store.get())).toBeUndefined();
  });

  it("start: reads now, every 60 s while active, stops in the background, reads again on foreground", async () => {
    jest.useFakeTimers();
    const f = fakeFlags();
    const stop = f.client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(2);
    f.appState.set("background");
    expect(f.client.polling).toBe(false);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.calls).toHaveLength(2); // nothing while in the background
    f.appState.set("active");
    await jest.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(3); // foreground read
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(4);
    stop();
    expect(f.appState.listeners()).toBe(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.calls).toHaveLength(4);
  });

  it("concurrent refreshes share one read", async () => {
    const f = fakeFlags();
    await Promise.all([f.client.refresh(), f.client.refresh(), f.client.refresh()]);
    expect(f.calls).toHaveLength(1);
  });
});
