// Earn's persisted state (resume after an app kill, MOBILE_PLAN N6). Two records per (chain, wallet), both non-secret:
//  - the RUN: core's basis-open or basis-close machine (exec/persist: versioned, bigint-safe, validated) + per-leg notes
//    keyed by the leg's stable key (`${id}:leg1`, `:leg2`, `:unwind1`, …): Perpl the account's last rq before sending,
//    Meridian the signed raw tx + nonce, then the ref / order id / fill / error the receipt timeline shows. Written after
//    every event; a terminal MANUAL run stays stored (the alert survives a relaunch) until the user dismisses it.
//  - the POSITION: the hedged pair Earn opened (Perpl side + size) and any one-sided leftover that needs a manual close.
//    Folding a terminal run into it is idempotent by run id, so a kill between "terminal saved" and "run cleared"
//    never counts a run twice.
// Holds no key material: rq numbers, order ids, a signed transaction (public once broadcast), amounts.
import { basisExposureWad, deserializeExec, opposite, serializeExec, type BasisExecState, type CloseExecState, type LegProgress, type LegSpec, type OrderSide } from "@meridian/core/exec";
import { parseBig, stringifyBig } from "@meridian/core/util";
import type { Hex } from "viem";

export type LegNote = {
  rqFloor?: number;
  raw?: Hex;
  nonce?: number;
  ref?: string;
  orderId?: number;
  filledWad?: bigint;
  avgPriceWad?: bigint;
  error?: string;
};

export type EarnMeta = {
  chainId: number;
  address: string;
  createdAtMs: number;
  /** the plain summary the user held to confirm */
  summary: string;
  perplPriceDp: number;
  meridianPriceDp: number;
  /** Perpl OrderSpec.lv (×100) for every Perpl leg of the run */
  leverage100: number;
  legs: Record<string, LegNote>;
  /** chain head when the run started */
  sentAtBlock?: bigint;
  /** __DEV__ builds only: force the Meridian open leg to fail (auto-unwind on the phone) */
  devFailMeridian?: boolean;
  /** Lock: collateral to add on the funding-swap market in the collateral step (WAD, whole AUSD units) */
  lockCollateralWad?: bigint;
  /** close with a Lock: the reduce-only swap order that runs BEFORE the perp legs (never leaves a swap without its hedge) */
  swapClose?: { leg: LegSpec; progress: LegProgress; filledWad?: bigint; error?: string };
};

export type EarnRun = BasisExecState | CloseExecState;
export type EarnRecord = { v: 1; state: EarnRun; meta: EarnMeta };

export const earnRunKey = (chainId: number, address: string) => `meridian.earn.run.${chainId}.${address.toLowerCase()}`;
export const earnPositionKey = (chainId: number, address: string) => `meridian.earn.position.${chainId}.${address.toLowerCase()}`;

export function encodeEarnRecord(r: EarnRecord): string {
  return stringifyBig({ v: 1, exec: serializeExec(r.state), meta: r.meta });
}

/** Validated decode; anything foreign or corrupt ⇒ undefined (never drives an order). */
export function decodeEarnRecord(text: string | null | undefined): EarnRecord | undefined {
  if (!text) return undefined;
  try {
    const o = parseBig(text) as { v?: unknown; exec?: unknown; meta?: unknown };
    if (o.v !== 1 || typeof o.exec !== "string" || typeof o.meta !== "object" || o.meta === null) return undefined;
    const state = deserializeExec(o.exec);
    if (state.kind !== "basis" && state.kind !== "close") return undefined;
    const meta = o.meta as EarnMeta;
    if (typeof meta.address !== "string" || typeof meta.chainId !== "number" || typeof meta.legs !== "object" || meta.legs === null) return undefined;
    if (Object.values(meta.legs).some((n) => typeof n !== "object" || n === null)) return undefined;
    return { v: 1, state, meta };
  } catch {
    return undefined;
  }
}

type Kv = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> };
export type EarnRecordStore = { load(): Promise<EarnRecord | undefined>; save(r: EarnRecord): Promise<void>; clear(): Promise<void> };

export function earnRecordStore(kv: Kv, chainId: number, address: string): EarnRecordStore {
  const key = earnRunKey(chainId, address);
  return { load: async () => decodeEarnRecord(await kv.get(key)), save: (r) => kv.set(key, encodeEarnRecord(r)), clear: () => kv.del(key) };
}

// ── the hedged position ──

export type EarnPosition = {
  v: 1;
  /** the Perpl leg's side while hedged (Meridian holds the opposite); undefined when flat */
  perplSide: OrderSide | undefined;
  /** hedged MON per venue */
  sizeWad: bigint;
  /** one-sided MON left after a MANUAL outcome, by venue; closing it is one tap on the Earn screen */
  naked: { venue: "perpl" | "meridian"; side: OrderSide; sizeWad: bigint } | undefined;
  /** run ids already folded in (bounded) */
  applied: string[];
};

export const FLAT: EarnPosition = { v: 1, perplSide: undefined, sizeWad: 0n, naked: undefined, applied: [] };
const MAX_APPLIED = 32;

export function decodePosition(text: string | null | undefined): EarnPosition {
  if (!text) return FLAT;
  try {
    const o = parseBig(text) as EarnPosition;
    if (o.v !== 1 || typeof o.sizeWad !== "bigint" || !Array.isArray(o.applied)) return FLAT;
    return o;
  } catch {
    return FLAT;
  }
}

export type PositionStore = { load(): Promise<EarnPosition>; save(p: EarnPosition): Promise<void> };
export function positionStore(kv: Kv, chainId: number, address: string): PositionStore {
  const key = earnPositionKey(chainId, address);
  return { load: async () => decodePosition(await kv.get(key)), save: (p) => kv.set(key, stringifyBig(p)) };
}

const addNaked = (n: EarnPosition["naked"], add: NonNullable<EarnPosition["naked"]>): EarnPosition["naked"] => {
  if (!n || n.venue !== add.venue) return add;
  const signed = (x: NonNullable<EarnPosition["naked"]>) => (x.side === "buy" ? x.sizeWad : -x.sizeWad);
  const sum = signed(n) + signed(add);
  return sum === 0n ? undefined : { venue: add.venue, side: sum > 0n ? "buy" : "sell", sizeWad: sum > 0n ? sum : -sum };
};

/** Fold a TERMINAL run into the position (idempotent by run id). */
export function applyRun(pos: EarnPosition, s: EarnRun): EarnPosition {
  if (pos.applied.includes(s.id)) return pos;
  const applied = [...pos.applied, s.id].slice(-MAX_APPLIED);
  let next: EarnPosition = { ...pos, applied };
  if (s.kind === "basis") {
    const hedged = s.phase === "ABORTED" || s.phase === "ABORTED_UNWOUND" ? 0n : (s.q2?.filledWad ?? 0n);
    if (hedged > 0n) next = { ...next, perplSide: s.plan.perplSide, sizeWad: next.sizeWad + hedged };
    // what the pair holds beyond the hedge (MANUAL: the Perpl part the unwind couldn't close)
    const exposure = basisExposureWad(s);
    if (exposure !== 0n) next = { ...next, naked: addNaked(next.naked, { venue: "perpl", side: exposure > 0n ? "buy" : "sell", sizeWad: exposure > 0n ? exposure : -exposure }) };
    return next;
  }
  const closedMeridian = s.meridian?.filledWad ?? 0n;
  const size = next.sizeWad - closedMeridian > 0n ? next.sizeWad - closedMeridian : 0n;
  next = { ...next, sizeWad: size, perplSide: size === 0n ? undefined : next.perplSide };
  const leftover = s.perpl.targetWad - s.perpl.filledWad;
  // Meridian closed more than Perpl: the still-open Perpl part is one-sided (same side the open Perpl leg had)
  if (leftover > 0n) next = { ...next, naked: addNaked(next.naked, { venue: "perpl", side: opposite(s.plan.perplSide), sizeWad: leftover }) };
  return next;
}

/** A manual close of the one-sided leftover filled `filledWad`. */
export function reduceNaked(pos: EarnPosition, filledWad: bigint): EarnPosition {
  if (!pos.naked) return pos;
  const left = pos.naked.sizeWad - filledWad;
  return { ...pos, naked: left > 0n ? { ...pos.naked, sizeWad: left } : undefined };
}
