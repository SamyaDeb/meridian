// The Trade screen's persisted trade (resume after an app kill, MOBILE_PLAN N5 §5). One pending trade per (chain,
// wallet): core's single-leg state (versioned, bigint-safe, validated: exec/persist) + what the legs need to resume
// without re-sending (Perpl: the account's last rq before sending; Meridian: the signed raw tx + its nonce) + what the
// receipt shows. Holds no key material: rq numbers, a signed transaction (public once broadcast), amounts.
import { deserializeExec, serializeExec, type SingleState } from "@meridian/core/exec";
import { parseBig, stringifyBig } from "@meridian/core/util";
import type { Venue } from "@meridian/core/route";
import type { Hex } from "viem";

export type TradeMeta = {
  chainId: number;
  address: string;
  venue: Venue;
  side: "long" | "short";
  /** what the user saw and accepted (summary line, receipt header) */
  summary: string;
  priceDp: number;
  stepWad: bigint;
  /** taker fee fraction (WAD) used for the Meridian receipt's fee (Perpl's fee comes from its fills) */
  takerFeeWad: bigint;
  leverage100: number;
  createdAtMs: number;
  /** chain head when the order went out (blocks-to-fill on the receipt) */
  sentAtBlock?: bigint;
  perpl?: { rqFloor?: number };
  /** raw / nonce: the signed order; needWad: margin + fee the venue must hold before sending (deposit the rest) */
  meridian?: { raw?: Hex; nonce?: number; needWad?: bigint };
};

export type TradeRecord = { v: 1; state: SingleState; meta: TradeMeta };

export const tradeKey = (chainId: number, address: string) => `meridian.trade.pending.${chainId}.${address.toLowerCase()}`;

export function encodeRecord(r: TradeRecord): string {
  return stringifyBig({ v: 1, exec: serializeExec(r.state), meta: r.meta });
}

/** Validated decode; anything foreign or corrupt ⇒ undefined (never drives an order). */
export function decodeRecord(text: string | null | undefined): TradeRecord | undefined {
  if (!text) return undefined;
  try {
    const o = parseBig(text) as { v?: unknown; exec?: unknown; meta?: unknown };
    if (o.v !== 1 || typeof o.exec !== "string" || typeof o.meta !== "object" || o.meta === null) return undefined;
    const state = deserializeExec(o.exec);
    if (state.kind !== "single") return undefined;
    const meta = o.meta as TradeMeta;
    if ((meta.venue !== "perpl" && meta.venue !== "meridian") || typeof meta.address !== "string" || typeof meta.chainId !== "number") return undefined;
    return { v: 1, state, meta };
  } catch {
    return undefined;
  }
}

export type RecordStore = { load(): Promise<TradeRecord | undefined>; save(r: TradeRecord): Promise<void>; clear(): Promise<void> };

export function recordStore(kv: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> }, chainId: number, address: string): RecordStore {
  const key = tradeKey(chainId, address);
  return {
    load: async () => decodeRecord(await kv.get(key)),
    save: (r) => kv.set(key, encodeRecord(r)),
    clear: () => kv.del(key),
  };
}
