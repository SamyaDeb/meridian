import { describe, expect, it } from "vitest";
import hedge from "./fixtures/account-10143-k3-hedge.json";
import market143 from "./fixtures/market-143.json";
import { cycle, newBot, readAll, type Fetch } from "../src/main";
import { evaluate, parseWatchList, positionReadings, spreadReading, type WatchList } from "../src/watch";

// Recorded /api/perpl/positions payload of the K3 hedge account (long 2,600 MON, liq 0.02239); the mark is moved
// per test to put the position at a chosen distance from liquidation.
const HEDGE = "0xFC76FE796f22665f0A48863Ff5d7a03A4FcD7775" as const;
const withMark = (markPNS: number) => ({ ...hedge.expected, positions: hedge.expected.positions.map((p) => ({ ...p, markPNS: String(markPNS) })) });
const WL: WatchList = { wallets: [{ address: HEDGE, chain: 10143, label: "k3 hedge", liqDistancePct: 15 }], hysteresisPct: 1, cooldownMin: 30 };
const ENV = { PAGE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc-DEF" };

function fakeNet(routes: Record<string, () => unknown>, status = 200) {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const k = Object.keys(routes).find((r) => url.includes(r));
    if (!k) return { ok: false, status: 404, json: async () => ({ error: "no route" }) };
    return { ok: status < 300, status, json: async () => routes[k]!() };
  };
  return { fetch, calls };
}
function fakePost() {
  const sent: { url: string; body: string }[] = [];
  return { sent, post: async (url: string, body: string) => (sent.push({ url, body }), { status: 204, text: async () => "" }) };
}

describe("watch list", () => {
  it("parses a valid list and rejects bad ones", () => {
    expect(parseWatchList({ ...WL, spread: { chain: 143, aprPct: 20 } }).spread).toEqual({ chain: 143, aprPct: 20 });
    expect(() => parseWatchList({ ...WL, wallets: [{ address: "0x12", chain: 10143, liqDistancePct: 5 }] })).toThrow(/address/);
    expect(() => parseWatchList({ ...WL, wallets: [{ address: HEDGE, chain: 1, liqDistancePct: 5 }] })).toThrow(/chain/);
    expect(() => parseWatchList({ ...WL, cooldownMin: 0 })).toThrow(/cooldown/);
  });
});

describe("readings use the app's risk math", () => {
  it("the recorded hedge position: distance from Perpl's own liquidation price", () => {
    const [r] = positionReadings(WL.wallets[0]!, withMark(2530));
    expect(r).toMatchObject({ kind: "position", side: "Long", name: "MON", thresholdBps: 1500n });
    expect(r!.kind === "position" && r!.distanceBps).toBe(1152n); // (0.02530 − 0.0223853…) / 0.02530 = 11.52 %, rounded down
  });
  it("spread: Meridian 10.95 % vs Perpl mainnet +3 per 100k per interval (36.67 %) ⇒ −25.72 %", () => {
    const r = spreadReading({ chain: 143, aprPct: 20 }, 109_500_000_000_000_000n, BigInt(market143.expected.fundingRatePct100k), 2580n);
    expect(r.kind === "spread" && r!.spreadAprWad).toBe(109_500_000_000_000_000n - 366_697_674_418_604_651n);
    expect(evaluate(new Set(), [r], 100n)[0]?.message).toContain("-25.71% APR");
  });
});

describe("alert lifecycle (fake clock, recorded payloads, no network)", () => {
  it("fires once, stays quiet inside the cooldown, repeats after it, holds inside the hysteresis band, then recovers", async () => {
    let mark = 2516; // ≈ 11 % from liquidation: inside the 15 % threshold
    const net = fakeNet({ "/api/perpl/positions": () => withMark(mark) });
    const out = fakePost();
    const bot = newBot();
    const run = (nowSec: number) => cycle(bot, WL, { appUrl: "https://app.test", fetch: net.fetch, post: out.post, nowSec, env: ENV });

    const first = await run(1_000);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("perpl_liq:10143:0xfc76fe796f22665f0a48863ff5d7a03a4fcd7775:64");
    expect(first[0]).toContain("k3 hedge Long MON on Perpl is 11.0");
    expect(out.sent[0]!.url).toBe(ENV.PAGE_DISCORD_WEBHOOK_URL);

    expect(await run(1_000 + 29 * 60)).toEqual([]); // inside the 30 min cooldown
    expect((await run(1_000 + 30 * 60))[0]).toContain("still firing");

    mark = 2650; // ≈ 15.5 %: past the threshold but inside the 1-point hysteresis band ⇒ still firing, no new page
    expect(await run(1_000 + 31 * 60)).toEqual([]);
    expect(bot.active.size).toBe(1);

    mark = 2700; // ≈ 17 %: clear ⇒ one recovery message
    const rec = await run(1_000 + 32 * 60);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain("✅ RESOLVED perpl_liq:10143:");
    expect(bot.active.size).toBe(0);
    expect(await run(1_000 + 33 * 60)).toEqual([]);
    expect(out.sent).toHaveLength(3);
    expect(net.calls.every((u) => u.startsWith("https://app.test/api/perpl/positions?chain=10143&address="))).toBe(true);
  });
  it("a position under half its threshold pages as critical", async () => {
    const out = fakePost();
    const msgs = await cycle(newBot(), { ...WL, wallets: [{ ...WL.wallets[0]!, liqDistancePct: 30 }] }, { appUrl: "https://app.test", fetch: fakeNet({ "/api/perpl/positions": () => withMark(2516) }).fetch, post: out.post, nowSec: 1, env: ENV });
    expect(msgs[0]).toContain("🔴");
  });
  it("a read failure is a warning with the route's own message, and it resolves when reads come back", async () => {
    const bot = newBot();
    const out = fakePost();
    const down = fakeNet({ "/api/perpl/positions": () => ({ error: "Monad testnet RPC unreachable" }) }, 502);
    const m1 = await cycle(bot, WL, { appUrl: "https://app.test", fetch: down.fetch, post: out.post, nowSec: 10, env: ENV });
    expect(m1[0]).toContain("🟠 alerts_read:10143:");
    expect(m1[0]).toContain("Monad testnet RPC unreachable");
    const ok = fakeNet({ "/api/perpl/positions": () => withMark(3000) });
    const m2 = await cycle(bot, WL, { appUrl: "https://app.test", fetch: ok.fetch, post: out.post, nowSec: 20, env: ENV });
    expect(m2[0]).toContain("✅ RESOLVED alerts_read:10143:");
  });
  it("spread alert reads Perpl's market route and the MFI's Meridian venue", async () => {
    const net = fakeNet({ "/api/perpl/market": () => market143.expected, "/v1/mfi": () => ({ venues: [{ id: "meridian", aprWad: "109500000000000000" }] }), "/api/perpl/positions": () => withMark(3000) });
    const r = await readAll({ ...WL, spread: { chain: 143, aprPct: 20 } }, "https://app.test", "https://mfi.test", net.fetch);
    expect(r.find((x) => x.kind === "spread")).toMatchObject({ code: "spread:143", thresholdBps: 2000n });
    // without the MFI service the spread is off (no Meridian rate to compare), not an error
    expect((await readAll({ ...WL, spread: { chain: 143, aprPct: 20 } }, "https://app.test", undefined, net.fetch)).some((x) => x.code.startsWith("spread"))).toBe(false);
  });
  it("no channel configured ⇒ nothing posted, still evaluated", async () => {
    const out = fakePost();
    const msgs = await cycle(newBot(), WL, { appUrl: "https://app.test", fetch: fakeNet({ "/api/perpl/positions": () => withMark(2516) }).fetch, post: out.post, nowSec: 1, env: {} });
    expect(msgs).toHaveLength(1);
    expect(out.sent).toHaveLength(0);
  });
});
