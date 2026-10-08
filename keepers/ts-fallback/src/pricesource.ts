// Keyless price sources for the TESTNET keeper-fed oracle (TestnetKeeperOracle, Phase 3 step 2b).
// Used only while there is no Pyth Hermes key (ARCHITECTURE R24). Verified reachable 30 Sep 2026:
//   1. mainnet Pyth MON/USD via getPriceUnsafe (contract + feed id: ARCHITECTURE R12; public RPC: R2) —
//      the same feed mainnet will use, sponsored-pushed every ~10–30 s;
//   2. fallback: Hyperliquid public `info` API `allMids` (ARCHITECTURE R23) — a perp mid, not a spot index,
//      and it carries no timestamp (the fetch time is used).
import { type Address, type Hex, type PublicClient, encodeAbiParameters, parseAbi } from "viem";
import { type PricePoint, WAD, pythToWad } from "./decide.js";

/** ARCHITECTURE R12 (mainnet Pyth). */
export const MAINNET_PYTH: Address = "0x2880aB155794e7179c9eE2e38200202908C17B43";
/** ARCHITECTURE R23. */
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export const pythReadAbi = parseAbi([
  "struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }",
  "function getPriceUnsafe(bytes32 id) view returns (Price)",
]);

export type PriceSourceName = "mainnet-pyth" | "hyperliquid";

export interface SourcedPrice extends PricePoint {
  source: PriceSourceName;
}

/**
 * Pyth `Price` → point, with the adapter's checks: price > 0, expo ∈ [−18, 0], conf ≤ 1% of price.
 * Returns null when unusable. Pure.
 */
export function pythPriceToPoint(p: { price: bigint; conf: bigint; expo: number; publishTime: bigint }): PricePoint | null {
  const priceWad = pythToWad(p.price, p.expo);
  if (priceWad === null) return null;
  if (p.conf * 100n > p.price) return null; // PythChainlinkOracleAdapter: conf · 100 ≤ price
  return { priceWad, publishTime: p.publishTime };
}

/** Exact decimal string ("0.027147") → WAD. Null for anything that is not a positive plain decimal. Pure. */
export function decimalToWad(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (m === null) return null;
  const int = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > 18) return null;
  const wad = BigInt(int) * WAD + BigInt(frac.padEnd(18, "0"));
  return wad > 0n ? wad : null;
}

/** Hyperliquid `{"type":"allMids"}` body → WAD mid for `coin`. Null if missing/invalid. Pure. */
export function parseHyperliquidMid(body: unknown, coin: string): bigint | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as Record<string, unknown>)[coin];
  return typeof v === "string" ? decimalToWad(v) : null;
}

/** `price × factor` (both WAD), rounded down. The demo market's crash lever (factor < 1e18). Pure. */
export function applyFactor(priceWad: bigint, factorWad: bigint): bigint {
  if (factorWad <= 0n) throw new Error("factor must be > 0");
  return (priceWad * factorWad) / WAD;
}

/**
 * The point pushed to a keeper-fed oracle. Main market: the source observation as is (price and publish time).
 * Demo test market (`demo`): price × factor, and publish time = max(source, now) so a factor change (the crash
 * lever) is pushed on the next block instead of waiting for the source's next publish. Pure.
 */
export function feedPoint(src: PricePoint, factorWad: bigint, nowSec: bigint, demo: boolean): PricePoint {
  if (!demo) return { priceWad: src.priceWad, publishTime: src.publishTime };
  return { priceWad: applyFactor(src.priceWad, factorWad), publishTime: src.publishTime > nowSec ? src.publishTime : nowSec };
}

/** updateData for TestnetKeeperOracle.updatePrice: `abi.encode(uint256 priceWad, uint256 publishTime)`. Pure. */
export function encodeTestOracleUpdate(p: PricePoint): Hex[] {
  return [encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [p.priceWad, p.publishTime])];
}

export async function readMainnetPyth(client: PublicClient, feedId: Hex): Promise<PricePoint | null> {
  const r = await client.readContract({ address: MAINNET_PYTH, abi: pythReadAbi, functionName: "getPriceUnsafe", args: [feedId] });
  return pythPriceToPoint(r);
}

export async function fetchHyperliquidMid(coin: string, nowSec: bigint): Promise<PricePoint | null> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`hyperliquid: HTTP ${res.status}`);
  const priceWad = parseHyperliquidMid(await res.json(), coin);
  return priceWad === null ? null : { priceWad, publishTime: nowSec };
}

/**
 * Primary mainnet Pyth; if it fails, is unusable, or is older than `maxSourceAgeSec`, fall back to Hyperliquid.
 * Returns null when neither source is usable (the keeper then pushes nothing and the oracle goes stale: safe).
 */
export async function latestKeylessPrice(
  mainnet: PublicClient | null,
  feedId: Hex,
  nowSec: bigint,
  maxSourceAgeSec: bigint,
  hyperliquidCoin = "MON",
): Promise<SourcedPrice | null> {
  if (mainnet !== null) {
    try {
      const p = await readMainnetPyth(mainnet, feedId);
      if (p !== null && nowSec - p.publishTime <= maxSourceAgeSec) return { ...p, source: "mainnet-pyth" };
    } catch {
      // fall through to the fallback source
    }
  }
  const h = await fetchHyperliquidMid(hyperliquidCoin, nowSec).catch(() => null);
  return h === null ? null : { ...h, source: "hyperliquid" };
}
