// Signed Perpl REST (authentication.md): every request is signed with the Ed25519 API key over a fresh timestamp + nonce.
// Extracted from PerplTrading.rest (meridian-k3/mm-bot/src/perpl/trading.ts, perpl-hedge @ fe873b0). Back-off on 429/503
// per README "Rate Limits" → REST ("exponential backoff", limits unpublished), with jitter and Retry-After honoured.
import { realClock, type Clock, type FetchLike, type RandomBytes } from "../util/runtime";
import { newNonce, restHeaders } from "./auth";
import { retryAfterMs } from "./client";
import { PerplHttpError } from "./errors";
import type { Account, BatchStatus, OrderSpec } from "./types";
import { parseAccount } from "./state";

export type SignedRestConfig = {
  apiUrl: string;
  chainId: number;
  apiKey: string;
  secret: Uint8Array;
  fetchFn: FetchLike;
  random: RandomBytes;
  clock?: Clock;
  /** total attempts on 429/503 (default 3) */
  attempts?: number;
  /** back-off base (default 1 s ⇒ 1, 2, 4 s ± 25 %) */
  backoffMs?: number;
};

/** Delay before retry `i` (0-based): max(Retry-After, base·2^i ± 25 %). */
export const restBackoffMs = (i: number, baseMs: number, random: () => number, retryAfter?: number): number =>
  Math.max(retryAfter ?? 0, Math.round(baseMs * 2 ** i * (0.75 + 0.5 * random())));

export type WalletSnapshot = { sn?: number; addr?: string; accounts: Account[] };

export function createSignedRest(c: SignedRestConfig) {
  const clock = c.clock ?? realClock;
  const attempts = Math.max(1, c.attempts ?? 3);
  const base = c.apiUrl.replace(/\/+$/, "");

  /** Signed call; 2xx ⇒ parsed JSON (or undefined), otherwise PerplHttpError with the status (404 = no exchange account). */
  async function call(method: "GET" | "POST", target: string, body = ""): Promise<unknown> {
    let lastStatus = 0;
    let lastText = "";
    for (let i = 0; i < attempts; i++) {
      // fresh timestamp + nonce on every attempt (nonces are single-use within the 30 s window)
      const headers = await restHeaders(c.apiKey, c.secret, { chainId: c.chainId, method, target, timestampMs: clock.now(), nonce: newNonce(c.random), body });
      const res = await c.fetchFn(`${base}${target}`, { method, headers: { ...headers, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      const text = await res.text();
      if (res.status === 429 || res.status === 503) {
        lastStatus = res.status;
        lastText = text;
        if (i + 1 < attempts) await new Promise<void>((r) => void clock.setTimeout(r, restBackoffMs(i, c.backoffMs ?? 1_000, clock.random, retryAfterMs(res.headers.get("retry-after")))));
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new PerplHttpError(res.status, method, target, text);
      return text ? JSON.parse(text) : undefined;
    }
    throw new PerplHttpError(lastStatus, method, target, lastText || "still 429/503 after retries");
  }

  return {
    call,
    /** GET /v1/trading/wallet (rest-endpoints.md): 404 ⇒ the wallet holds no exchange account. */
    wallet: async (): Promise<WalletSnapshot> => {
      const w = (await call("GET", "/v1/trading/wallet")) as { sn?: number; addr?: string; as?: unknown[] };
      return { ...(typeof w.sn === "number" ? { sn: w.sn } : {}), ...(typeof w.addr === "string" ? { addr: w.addr } : {}), accounts: (w.as ?? []).map(parseAccount) };
    },
    orders: () => call("GET", "/v1/trading/orders"),
    positions: () => call("GET", "/v1/trading/positions"),
    orderHistory: (count = 20) => call("GET", `/v1/trading/order-history?count=${count}`),
    fills: (count = 20) => call("GET", `/v1/trading/fills?count=${count}`),
    /** POST /v1/trading/orders: ≤ 100 per batch; read every statuses[i] (HTTP 200 means "judged", not "accepted"). */
    placeOrders: async (sn: number, d: OrderSpec[]): Promise<BatchStatus> => {
      if (d.length === 0 || d.length > 100) throw new RangeError("a batch holds 1–100 orders");
      return (await call("POST", "/v1/trading/orders", JSON.stringify({ sn, d }))) as BatchStatus;
    },
  };
}

export type SignedRest = ReturnType<typeof createSignedRest>;
