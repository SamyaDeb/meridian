import { describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts.js";
import { DEFAULT_PAGER as C, type PostFn, buildRequest, channelFromEnv, deliver, newPagerState, planPages } from "../src/paging.js";

const crit: Alert = { severity: "critical", code: "oracle_stale", message: "oracle reports stale" };
const warn: Alert = { severity: "warn", code: "keeper_balance", message: "keeper low" };
const DISCORD = "https://discord.com/api/webhooks/123456789/abc-DEF_1";

describe("planPages: de-dup, reminders, resolve, rate limit", () => {
  it("pages on the first cycle only, reminds after repeat, resolves once", () => {
    const st = newPagerState();
    expect(planPages(st, [crit], 0, C, "Pulse 143")).toEqual(["[Pulse 143] 🔴 oracle_stale: oracle reports stale"]);
    expect(planPages(st, [crit], 15, C, "Pulse 143")).toEqual([]);
    expect(planPages(st, [crit], 899, C, "Pulse 143")).toEqual([]);
    expect(planPages(st, [crit], 900, C, "Pulse 143")[0]).toContain("still firing, 900 s");
    expect(planPages(st, [], 960, C, "Pulse 143")).toEqual(["[Pulse 143] ✅ RESOLVED oracle_stale (fired for 960 s)"]);
    expect(planPages(st, [], 975, C, "Pulse 143")).toEqual([]);
  });

  it("warn repeats every 2 h, and a flapping code re-pages as new", () => {
    const st = newPagerState();
    planPages(st, [warn], 0, C, "x");
    expect(planPages(st, [warn], 7_199, C, "x")).toEqual([]);
    expect(planPages(st, [warn], 7_200, C, "x")).toHaveLength(1);
    planPages(st, [], 7_300, C, "x");
    expect(planPages(st, [warn], 7_400, C, "x")[0]).toContain("keeper_balance: keeper low");
  });

  it("several codes in one cycle = one message; duplicates of a code collapse", () => {
    const st = newPagerState();
    const out = planPages(st, [crit, warn, { ...crit, message: "dup" }], 0, C, "x");
    expect(out).toHaveLength(1);
    expect(out[0]!.split("\n")).toHaveLength(2);
  });

  it("at most maxPerWindow messages per window; the overflow is folded into the next message, not dropped", () => {
    const st = newPagerState();
    const cfg = { ...C, maxPerWindow: 2, windowSec: 60 };
    const a = (i: number): Alert => ({ severity: "critical", code: `c${i}`, message: `m${i}` });
    expect(planPages(st, [a(1)], 0, cfg, "x")).toHaveLength(1);
    expect(planPages(st, [a(1), a(2)], 1, cfg, "x")).toHaveLength(1);
    expect(planPages(st, [a(1), a(2), a(3)], 2, cfg, "x")).toEqual([]); // budget spent
    const later = planPages(st, [a(1), a(2), a(3), a(4)], 61, cfg, "x");
    expect(later).toHaveLength(1);
    expect(later[0]).toContain("c3: m3");
    expect(later[0]).toContain("c4: m4");
  });
});

describe("channel + provider requests (shapes per provider docs)", () => {
  it("Discord: {content} ≤ 2,000 chars to the webhook URL", () => {
    const ch = channelFromEnv({ PAGE_DISCORD_WEBHOOK_URL: DISCORD });
    const r = buildRequest(ch, "x".repeat(2_500))!;
    expect(r.url).toBe(DISCORD);
    expect(r.body.content).toHaveLength(2_000);
  });
  it("Telegram: sendMessage {chat_id, text}", () => {
    const ch = channelFromEnv({ PAGE_TELEGRAM_BOT_TOKEN: "123:ABC", PAGE_TELEGRAM_CHAT_ID: "-1001" });
    expect(buildRequest(ch, "hi")).toEqual({ url: "https://api.telegram.org/bot123:ABC/sendMessage", body: { chat_id: "-1001", text: "hi" } });
  });
  it("exactly one channel; half or both configured is an error; none = print only", () => {
    expect(channelFromEnv({})).toEqual({ kind: "none" });
    expect(() => channelFromEnv({ PAGE_TELEGRAM_BOT_TOKEN: "1:a" })).toThrow();
    expect(() => channelFromEnv({ PAGE_DISCORD_WEBHOOK_URL: DISCORD, PAGE_TELEGRAM_CHAT_ID: "1" })).toThrow(/ONE/);
    expect(() => channelFromEnv({ PAGE_DISCORD_WEBHOOK_URL: "https://evil.example/hook" })).toThrow();
  });
});

describe("deliver", () => {
  it("2xx ok; errors reported with the secret redacted; a throw never escapes", async () => {
    const ch = channelFromEnv({ PAGE_TELEGRAM_BOT_TOKEN: "123:SECRET", PAGE_TELEGRAM_CHAT_ID: "1" });
    const bodies: string[] = [];
    const ok: PostFn = async (_u, b) => (bodies.push(b), { status: 200, text: async () => "" });
    expect((await deliver(ch, "hi", ok)).ok).toBe(true);
    expect(JSON.parse(bodies[0]!)).toEqual({ chat_id: "1", text: "hi" });
    const bad: PostFn = async () => ({ status: 429, text: async () => '{"ok":false,"parameters":{"retry_after":3}}' });
    expect(await deliver(ch, "hi", bad)).toEqual({ ok: false, detail: 'HTTP 429 {"ok":false,"parameters":{"retry_after":3}}' });
    const boom: PostFn = async (u) => {
      throw new Error(`connect failed ${u}`);
    };
    const r = await deliver(ch, "hi", boom);
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain("SECRET");
    expect((await deliver({ kind: "none" }, "hi", boom)).ok).toBe(true);
  });
});
