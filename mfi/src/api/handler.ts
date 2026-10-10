// Read-only JSON API (docs/MFI.md §7). Pure request → response so the contract is testable without a socket.
import type { MfiService } from "../mfi/service";

export type ApiResponse = { status: number; headers: Record<string, string>; body: unknown };
const HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
const json = (status: number, body: unknown): ApiResponse => ({ status, headers: HEADERS, body });

export function handle(svc: MfiService, method: string, rawUrl: string, nowMs: number, health: () => unknown): ApiResponse {
  if (method === "OPTIONS") return { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET" }, body: null };
  if (method !== "GET") return json(405, { error: "method not allowed" });
  const url = new URL(rawUrl, "http://mfi.local");
  switch (url.pathname) {
    case "/v1/mfi": {
      const s = svc.served(nowMs);
      return s ? json(200, s) : json(503, { error: "warming up: no cycle completed yet" });
    }
    case "/v1/mfi/history":
    case "/v1/mfi/spread": {
      const num = (k: string, d: number) => {
        const v = url.searchParams.get(k);
        if (v === null) return d;
        return /^\d+$/.test(v) ? Number(v) : NaN;
      };
      const from = num("from", 0);
      const to = num("to", nowMs);
      const limit = num("limit", 500);
      if (![from, to, limit].every(Number.isSafeInteger) || from > to || limit < 1 || limit > 1000) return json(400, { error: "from, to (ms) and limit (1..1000) must be integers, from <= to" });
      if (url.pathname === "/v1/mfi/history") return json(200, { version: "mfi-v0", points: svc.historyRange(from, to, limit) });
      const s = svc.served(nowMs);
      const current = s ? { spread: s.spread, fees: s.fees, stale: s.stale, updatedAt: s.updatedAt, updatedBlock: s.updatedBlock } : null;
      return json(200, { version: "mfi-v0", current, points: svc.spreadRange(from, to, limit) });
    }
    case "/healthz":
      return json(200, health());
    default:
      return json(404, { error: "not found" });
  }
}
