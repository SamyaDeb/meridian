// Transport = how a request reaches Perpl. Swapping the real HTTP transport for fixtures is a one-file change.
export type TransportResponse = { status: number; body: unknown; retryAfterMs?: number };
export type PerplTransport = (path: string, signal: AbortSignal) => Promise<TransportResponse>;

/** Mainnet / testnet REST base URLs from Perpl's README "Configuration" (api-docs @ 25ab6e2). Prefer env PERPL_API_URL. */
export const PERPL_API_URL = { mainnet: "https://app.perpl.xyz/api", testnet: "https://testnet.perpl.xyz/api" } as const;

export function httpTransport(baseUrl: string, fetchFn: typeof fetch = fetch): PerplTransport {
  const base = baseUrl.replace(/\/+$/, "");
  return async (path, signal) => {
    const res = await fetchFn(`${base}${path}`, { signal, headers: { accept: "application/json" } });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body (e.g. an HTML error page): the client reports it as a schema/HTTP error
    }
    const ra = res.headers.get("retry-after");
    const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
    return retryAfterMs === undefined ? { status: res.status, body } : { status: res.status, body, retryAfterMs };
  };
}

/** Fixture transport: path → response (or a function of the call count, to script retries). Unknown path ⇒ 404. */
export function fixtureTransport(routes: Record<string, TransportResponse | ((call: number) => TransportResponse)>): PerplTransport & { calls: string[] } {
  const calls: string[] = [];
  const t = async (path: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    calls.push(path);
    const r = routes[path];
    if (!r) return { status: 404, body: { error: "not found" } };
    return typeof r === "function" ? r(calls.filter((c) => c === path).length) : r;
  };
  return Object.assign(t, { calls });
}
