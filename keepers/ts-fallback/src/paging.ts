// Paging for the watcher (Phase 5 B6): de-duplicated, rate-limited delivery of src/alerts.ts findings to ONE channel
// the team picks in .env: a Discord webhook (PAGE_DISCORD_WEBHOOK_URL) or a Telegram bot (PAGE_TELEGRAM_BOT_TOKEN +
// PAGE_TELEGRAM_CHAT_ID). Provider API shapes, from their docs (fetched 30 Sep 2026):
// - Discord "Execute Webhook": POST /webhooks/{webhook.id}/{webhook.token}, JSON {"content"} ≤ 2,000 characters; 204 No
//   Content without `?wait=true` (docs.discord.com/developers/resources/webhook).
// - Telegram Bot API: https://api.telegram.org/bot<token>/sendMessage, JSON {"chat_id", "text"}; response {"ok", …},
//   on errors {"ok": false, "error_code", "description", "parameters": {"retry_after"}} (core.telegram.org/bots/api).
//   Text is capped at 4,000 characters here (Bot API limit 4,096 after entity parsing).
// Rules: a code pages when it starts firing, again every `repeatSec` while it keeps firing (critical 15 min, warn
// 2 h), and once with RESOLVED when it clears. At most `maxPerWindow` messages per `windowSec`; anything over the
// budget is folded into the next message instead of being dropped.
import type { Alert } from "./alerts.js";

export interface PagerConfig {
  repeatCriticalSec: number; // 900
  repeatWarnSec: number; // 7,200
  maxPerWindow: number; // 6
  windowSec: number; // 60
}

export const DEFAULT_PAGER: PagerConfig = { repeatCriticalSec: 900, repeatWarnSec: 7_200, maxPerWindow: 6, windowSec: 60 };

interface Firing {
  alert: Alert;
  since: number;
  lastPaged: number | null;
}

export interface PagerState {
  firing: Map<string, Firing>;
  sent: number[]; // send times (s) inside the rate window
  backlog: string[]; // lines held back by the rate limit
}

export const newPagerState = (): PagerState => ({ firing: new Map(), sent: [], backlog: [] });

const line = (a: Alert): string => `${a.severity === "critical" ? "🔴" : "🟠"} ${a.code}: ${a.message}`;

/**
 * One watcher cycle: update what is firing and return the messages to send now (≤ the rate budget). Mutates `st`.
 * `label` prefixes every message (e.g. "Pulse 143").
 */
export function planPages(st: PagerState, alerts: Alert[], nowSec: number, cfg: PagerConfig, label: string): string[] {
  const lines: string[] = [];
  const current = new Map<string, Alert>();
  for (const a of alerts) if (!current.has(a.code)) current.set(a.code, a);
  for (const [code, f] of st.firing) {
    if (!current.has(code)) {
      st.firing.delete(code);
      if (f.lastPaged !== null) lines.push(`✅ RESOLVED ${code} (fired for ${Math.round(nowSec - f.since)} s)`);
    }
  }
  for (const [code, a] of current) {
    const f = st.firing.get(code);
    const repeat = a.severity === "critical" ? cfg.repeatCriticalSec : cfg.repeatWarnSec;
    if (f === undefined) {
      st.firing.set(code, { alert: a, since: nowSec, lastPaged: nowSec });
      lines.push(line(a));
    } else {
      f.alert = a;
      if (f.lastPaged === null || nowSec - f.lastPaged >= repeat) {
        f.lastPaged = nowSec;
        lines.push(`${line(a)} (still firing, ${Math.round(nowSec - f.since)} s)`);
      }
    }
  }
  st.backlog.push(...lines);
  st.sent = st.sent.filter((t) => nowSec - t < cfg.windowSec);
  if (st.backlog.length === 0 || st.sent.length >= cfg.maxPerWindow) return [];
  // one message per cycle carries everything pending (the budget counts messages, not lines)
  const msg = `[${label}] ${st.backlog.join("\n")}`;
  st.backlog = [];
  st.sent.push(nowSec);
  return [msg];
}

export type Channel =
  | { kind: "discord"; webhookUrl: string }
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "none" };

/** Channel from env; a half-configured Telegram, or both channels at once, is an error (pick ONE). */
export function channelFromEnv(e: Record<string, string | undefined>): Channel {
  const d = e.PAGE_DISCORD_WEBHOOK_URL;
  const tok = e.PAGE_TELEGRAM_BOT_TOKEN;
  const chat = e.PAGE_TELEGRAM_CHAT_ID;
  if (d && (tok || chat)) throw new Error("configure ONE paging channel: Discord or Telegram, not both");
  if (d) {
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(d)) {
      throw new Error("PAGE_DISCORD_WEBHOOK_URL is not a Discord webhook URL");
    }
    return { kind: "discord", webhookUrl: d };
  }
  if (tok || chat) {
    if (!tok || !chat) throw new Error("Telegram paging needs PAGE_TELEGRAM_BOT_TOKEN and PAGE_TELEGRAM_CHAT_ID");
    return { kind: "telegram", botToken: tok, chatId: chat };
  }
  return { kind: "none" };
}

export interface HttpRequest {
  url: string;
  body: Record<string, string>;
}

/** The provider request for one message (text capped to the provider's limit). */
export function buildRequest(ch: Channel, text: string): HttpRequest | null {
  const cap = (n: number): string => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);
  if (ch.kind === "discord") return { url: ch.webhookUrl, body: { content: cap(2_000) } };
  if (ch.kind === "telegram") {
    return { url: `https://api.telegram.org/bot${ch.botToken}/sendMessage`, body: { chat_id: ch.chatId, text: cap(4_000) } };
  }
  return null;
}

export type PostFn = (url: string, body: string) => Promise<{ status: number; text(): Promise<string> }>;

/** Send one message; true on success. Never throws (a paging failure must not stop the watcher), never logs the URL. */
export async function deliver(ch: Channel, text: string, post: PostFn): Promise<{ ok: boolean; detail: string }> {
  const req = buildRequest(ch, text);
  if (req === null) return { ok: true, detail: "no channel" };
  const secrets = ch.kind === "discord" ? [ch.webhookUrl] : ch.kind === "telegram" ? [ch.botToken] : [];
  const redact = (x: string): string => secrets.reduce((acc, sec) => acc.split(sec).join("***"), x);
  try {
    const r = await post(req.url, JSON.stringify(req.body));
    if (r.status >= 200 && r.status < 300) return { ok: true, detail: String(r.status) };
    return { ok: false, detail: redact(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`) };
  } catch (e) {
    return { ok: false, detail: redact(e instanceof Error ? e.message.split("\n")[0]! : String(e)) };
  }
}
