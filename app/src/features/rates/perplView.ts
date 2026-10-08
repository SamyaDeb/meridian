// Pure view model of the Perpl position monitor: the /api/perpl/positions payload → each position's risk, shocks,
// funding cost and countdown, all through @meridian/risk (the same module the alerts bot uses).
import {
  SHOCKS_BPS,
  WAD,
  divCeil,
  divFloor,
  fundingCostPerDayWad,
  perplAprFromPct100k,
  perplCountdown,
  perplPositionRisk,
  perplShock,
  type Countdown,
  type PerplMarketParams,
  type PerplPositionRaw,
  type PerplPositionRisk,
  type Shock,
} from "@meridian/risk";
import type { Address } from "viem";
import { isPerplChain, type PerplAccountWire, type PerplChainId, type PerplPositionWire } from "./perplChain";

type Raw = Record<string, unknown>;
const obj = (v: unknown, f: string): Raw => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`perpl: bad ${f}`);
  return v as Raw;
};
const int = (v: unknown, f: string): string => {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) throw new Error(`perpl: bad ${f}`);
  return v;
};
const num = (v: unknown, f: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`perpl: bad ${f}`);
  return v;
};

const POSITION_INTS = [
  "depositCNS",
  "pricePNS",
  "priceResiduePNSQ16",
  "lotLNS",
  "entryBlock",
  "pnlCNS",
  "deltaPnlCNS",
  "premiumPnlCNS",
  "markPNS",
  "maintMarginHdths",
  "initMarginHdths",
  "fundingRatePct100k",
  "lastFundingEventBlock",
  "fundingIntervalBlocks",
  "takerFeeMicros",
  "makerFeeMicros",
] as const;

/** Pure: route body → PerplAccountWire. Throws on any field out of shape (the card then says "unavailable"). */
export function parseAccountWire(body: unknown): PerplAccountWire & { stale: boolean } {
  const b = obj(body, "body");
  const chainId = num(b.chainId, "chainId");
  if (!isPerplChain(chainId)) throw new Error("perpl: bad chainId");
  if (typeof b.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) throw new Error("perpl: bad address");
  const a = b.account === null ? null : obj(b.account, "account");
  if (!Array.isArray(b.positions) || !Array.isArray(b.unknownPerps)) throw new Error("perpl: bad positions");
  return {
    chainId,
    address: b.address as Address,
    block: int(b.block, "block"),
    account: a ? { accountId: int(a.accountId, "accountId"), balanceCNS: int(a.balanceCNS, "balanceCNS"), lockedBalanceCNS: int(a.lockedBalanceCNS, "lockedBalanceCNS"), frozen: num(a.frozen, "frozen") } : null,
    positions: b.positions.map((x, i) => {
      const p = obj(x, `positions.${i}`);
      const out = { perpId: num(p.perpId, "perpId"), name: String(p.name ?? ""), positionType: num(p.positionType, "positionType"), markValid: p.markValid === true, priceDecimals: num(p.priceDecimals, "priceDecimals"), lotDecimals: num(p.lotDecimals, "lotDecimals"), fundingIntervalSec: num(p.fundingIntervalSec, "fundingIntervalSec") } as PerplPositionWire;
      for (const k of POSITION_INTS) (out as Record<string, unknown>)[k] = int(p[k], k);
      return out;
    }),
    unknownPerps: b.unknownPerps.map((x) => num(x, "unknownPerps")),
    stale: b.stale === true,
  };
}

export type MonitoredPosition = {
  perpId: number;
  name: string;
  chainId: PerplChainId;
  priceDecimals: number;
  markValid: boolean;
  risk: PerplPositionRisk;
  shocks: Shock[];
  /** Perpl rate in force (getPerpetualInfoV2.fundingRatePct100k) annualized */
  perplAprWad: bigint;
  /** + pays / − receives per day, AUSD WAD; at the Perpl rate and (when the MFI service answers) at the MFI */
  fundingPerDayPerplWad: bigint;
  fundingPerDayMfiWad?: bigint;
  countdown: Countdown;
  takerFeeMicros: bigint;
  raw: PerplPositionRaw;
  params: PerplMarketParams;
};

export function toRaw(p: PerplPositionWire): PerplPositionRaw {
  return {
    positionType: p.positionType,
    depositCNS: BigInt(p.depositCNS),
    pricePNS: BigInt(p.pricePNS),
    priceResiduePNSQ16: BigInt(p.priceResiduePNSQ16),
    lotLNS: BigInt(p.lotLNS),
    deltaPnlCNS: BigInt(p.deltaPnlCNS),
    premiumPnlCNS: BigInt(p.premiumPnlCNS),
  };
}

/** Pure: every open position of the payload with its risk (Perpl's own margin rule, @meridian/risk perpl.ts). */
export function monitor(w: PerplAccountWire, mfiAprWad?: bigint | null): MonitoredPosition[] {
  const head = BigInt(w.block);
  return w.positions.map((p) => {
    const raw = toRaw(p);
    const params = { priceDecimals: p.priceDecimals, lotDecimals: p.lotDecimals, maintMarginHdths: BigInt(p.maintMarginHdths) };
    const mark = BigInt(p.markPNS);
    const risk = perplPositionRisk(raw, mark, params);
    const perplAprWad = perplAprFromPct100k(BigInt(p.fundingRatePct100k), BigInt(p.fundingIntervalSec));
    return {
      perpId: p.perpId,
      name: p.name,
      chainId: w.chainId,
      priceDecimals: p.priceDecimals,
      markValid: p.markValid,
      risk,
      shocks: SHOCKS_BPS.map((b) => perplShock(raw, mark, params, b)),
      perplAprWad,
      fundingPerDayPerplWad: fundingCostPerDayWad(risk.side, risk.sizeWad, risk.markWad, perplAprWad),
      ...(mfiAprWad !== undefined && mfiAprWad !== null ? { fundingPerDayMfiWad: fundingCostPerDayWad(risk.side, risk.sizeWad, risk.markWad, mfiAprWad) } : {}),
      countdown: perplCountdown(BigInt(p.lastFundingEventBlock), head, BigInt(p.fundingIntervalBlocks), BigInt(p.fundingIntervalSec)),
      takerFeeMicros: BigInt(p.takerFeeMicros),
      raw,
      params,
    };
  });
}

/**
 * A WAD price at the market's own price decimals (how Perpl quotes it), rounded in the given direction: the
 * liquidation price is shown rounded toward the mark (long up, short down), like the value itself.
 */
export function formatPerplPrice(wad: bigint, priceDecimals: number, round: "up" | "down" = "down"): string {
  const scale = 10n ** BigInt(18 - priceDecimals);
  const q = round === "up" ? divCeil(wad, scale) : divFloor(wad, scale);
  const s = q.toString().padStart(priceDecimals + 1, "0");
  return priceDecimals === 0 ? s : `${s.slice(0, -priceDecimals)}.${s.slice(-priceDecimals)}`;
}

/** bps → "12.35%" (rounds toward zero). */
export const bpsPct = (bps: bigint, dp = 2): string => {
  const neg = bps < 0n;
  const v = neg ? -bps : bps;
  const scaled = (v * 10n ** BigInt(dp)) / 100n;
  const s = scaled.toString().padStart(dp + 1, "0");
  return `${neg ? "−" : ""}${dp > 0 ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s}%`;
};

export const leverageLabel = (levWad: bigint) => `${(Number((levWad * 100n) / WAD) / 100).toFixed(2)}x`;

/** Shareable monitor URL: /rates?perpl=<address>&chain=<id>. */
export const monitorHref = (address: string, chainId: PerplChainId) => `/rates?perpl=${address}&chain=${chainId}#perpl-monitor`;

const MARKET_INTS = ["block", "markPNS", "fundingRatePct100k", "lastFundingEventBlock", "fundingIntervalBlocks", "longOpenInterestLNS", "shortOpenInterestLNS", "takerFeeMicros", "makerFeeMicros", "maintMarginHdths", "initMarginHdths"] as const;
export type PerplMarketNow = { chainId: PerplChainId; perpId: number; name: string; priceDecimals: number; lotDecimals: number; fundingIntervalSec: bigint; stale: boolean } & Record<(typeof MARKET_INTS)[number], bigint>;

/** Pure: /api/perpl/market body → bigints. Throws on a field out of shape. */
export function parseMarketWire(body: unknown): PerplMarketNow {
  const b = obj(body, "body");
  const chainId = num(b.chainId, "chainId");
  if (!isPerplChain(chainId)) throw new Error("perpl: bad chainId");
  const out = { chainId, perpId: num(b.perpId, "perpId"), name: String(b.name ?? ""), priceDecimals: num(b.priceDecimals, "priceDecimals"), lotDecimals: num(b.lotDecimals, "lotDecimals"), fundingIntervalSec: BigInt(num(b.fundingIntervalSec, "fundingIntervalSec")), stale: b.stale === true } as PerplMarketNow;
  for (const k of MARKET_INTS) (out as Record<string, unknown>)[k] = BigInt(int(b[k], k));
  return out;
}

/** GET a Perpl route; a non-2xx carries the route's own message (which RPC is missing / down). */
export async function getPerplRoute(path: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(path, { signal });
  const body: unknown = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return body;
}

/** Lots the visible Meridian book can fill on one side (the offset is clipped to it; the ticket re-checks slippage). */
export const visibleBookLots = (levels: readonly { sizeWad: bigint }[] | undefined, lotSizeWad: bigint): bigint | undefined =>
  levels === undefined ? undefined : levels.reduce((n, l) => n + l.sizeWad / lotSizeWad, 0n);
