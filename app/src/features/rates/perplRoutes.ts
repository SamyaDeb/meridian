// Request handling for /api/perpl/positions and /api/perpl/market, kept apart from the route files so tests can run it
// with a recorded reader (no network). Read-only; RPC from env (perplChain.serverRpcUrl).
import { createPublicClient, http, isAddress } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { PERPL_CHAIN_LABEL, PerplReadError, isPerplChain, readPerplAccount, readPerplMarket, rpcEnvName, serverRpcUrl, type PerplChainId, type PerplReader } from "./perplChain";
import { createTtlCache } from "./ttlCache";

export const POSITIONS_TTL_MS = 5_000;
const accounts = createTtlCache<Awaited<ReturnType<typeof readPerplAccount>>>({ ttlMs: POSITIONS_TTL_MS, staleMaxMs: 30_000 });
const markets = createTtlCache<Awaited<ReturnType<typeof readPerplMarket>>>({ ttlMs: POSITIONS_TTL_MS, staleMaxMs: 30_000 });

const readers = new Map<string, PerplReader>();
/** One viem client per chain + URL; reads in one tick go out as one Multicall3 call (address from viem's chain def). */
export function defaultReader(chainId: PerplChainId, env: Record<string, string | undefined> = process.env): PerplReader | undefined {
  const url = serverRpcUrl(chainId, env);
  if (!url) return undefined;
  const key = `${chainId}|${url}`;
  let r = readers.get(key);
  if (!r) {
    r = createPublicClient({ chain: chainId === 143 ? monad : monadTestnet, transport: http(url, { retryCount: 0, timeout: 8_000 }) }) as unknown as PerplReader;
    readers.set(key, r);
  }
  return r;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": status === 200 ? "public, s-maxage=5, stale-while-revalidate=5" : "no-store" } });

export function parseChain(v: string | null): PerplChainId | undefined {
  const n = Number(v ?? "10143");
  return Number.isInteger(n) && isPerplChain(n) ? n : undefined;
}

type Deps = { reader?: (chainId: PerplChainId) => PerplReader | undefined };

/** GET /api/perpl/positions?address=0x…&chain=10143|143 */
export async function handlePositions(url: URL, deps: Deps = {}): Promise<Response> {
  const chainId = parseChain(url.searchParams.get("chain"));
  if (chainId === undefined) return json({ error: "chain must be 10143 (Monad testnet) or 143 (Monad mainnet)" }, 400);
  const address = url.searchParams.get("address") ?? "";
  if (!isAddress(address, { strict: false })) return json({ error: "not an EVM address" }, 400);
  const reader = (deps.reader ?? defaultReader)(chainId);
  if (!reader) return json({ error: `${PERPL_CHAIN_LABEL[chainId]} RPC not configured (${rpcEnvName(chainId)})`, rpc: "missing" }, 503);
  const r = await accounts.get(`${chainId}:${address.toLowerCase()}`, () => readPerplAccount(reader, chainId, address), describe(chainId));
  if (!r.ok) return json({ error: r.error, rpc: r.status === 429 ? "rate-limited" : "down", ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) }, r.status === 429 ? 503 : 502);
  return json({ ...r.value, stale: r.stale, readAt: r.at }, 200);
}

/** GET /api/perpl/market?chain=10143|143 */
export async function handleMarket(url: URL, deps: Deps = {}): Promise<Response> {
  const chainId = parseChain(url.searchParams.get("chain"));
  if (chainId === undefined) return json({ error: "chain must be 10143 (Monad testnet) or 143 (Monad mainnet)" }, 400);
  const reader = (deps.reader ?? defaultReader)(chainId);
  if (!reader) return json({ error: `${PERPL_CHAIN_LABEL[chainId]} RPC not configured (${rpcEnvName(chainId)})`, rpc: "missing" }, 503);
  const r = await markets.get(String(chainId), () => readPerplMarket(reader, chainId), describe(chainId));
  if (!r.ok) return json({ error: r.error, rpc: r.status === 429 ? "rate-limited" : "down" }, r.status === 429 ? 503 : 502);
  return json({ ...r.value, stale: r.stale, readAt: r.at }, 200);
}

// our own message, never an RPC URL or upstream body (the URL can carry a key)
const describe = (chainId: PerplChainId) => (e: unknown) => (e instanceof PerplReadError ? e.message : `${PERPL_CHAIN_LABEL[chainId]} RPC unreachable`);
