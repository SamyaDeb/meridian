// Rates & Risk alerts (K5 step 5): the watch list, the readings, and a hysteresis evaluator that turns readings into
// keeper-style alerts (ts-fallback/src/alerts.ts shape) for the shared pager (ts-fallback/src/paging.ts).
// Pure: no clock, no network.
import { readFileSync } from "node:fs";
import { abs, perplAprFromPct100k, perplPositionRisk, spreadAprWad, type PerplPositionRaw } from "@meridian/risk";
import type { Alert } from "@meridian/keeper-ts/src/alerts.js";

export type ChainId = 10143 | 143;
export type WatchList = {
  /** Perpl wallets to watch: page when any open position's distance to liquidation drops below `liqDistancePct` */
  wallets: { address: `0x${string}`; chain: ChainId; label?: string; liqDistancePct: number }[];
  /** page when |APR_meridian − APR_perpl| on that Perpl chain exceeds this many APR points (omit to disable) */
  spread?: { chain: ChainId; aprPct: number };
  /** a condition clears only this many points past its threshold (no flapping) */
  hysteresisPct: number;
  /** repeat a still-firing condition at most this often (also the pager's repeat) */
  cooldownMin: number;
};

const isChain = (n: unknown): n is ChainId => n === 10143 || n === 143;
const pctOk = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;

/** Pure: JSON → WatchList; throws on anything out of shape (the bot refuses to start on a bad list). */
export function parseWatchList(j: unknown): WatchList {
  const o = j as Partial<WatchList> | null;
  if (!o || !Array.isArray(o.wallets)) throw new Error("watch list: `wallets` must be an array");
  const wallets = o.wallets.map((w, i) => {
    if (!w || typeof w.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw new Error(`watch list: wallets[${i}].address`);
    if (!isChain(w.chain)) throw new Error(`watch list: wallets[${i}].chain must be 10143 or 143`);
    if (!pctOk(w.liqDistancePct, 100)) throw new Error(`watch list: wallets[${i}].liqDistancePct must be in (0, 100]`);
    return { address: w.address, chain: w.chain, liqDistancePct: w.liqDistancePct, ...(typeof w.label === "string" ? { label: w.label } : {}) };
  });
  if (o.spread !== undefined && (!isChain(o.spread.chain) || !pctOk(o.spread.aprPct, 10_000))) throw new Error("watch list: spread needs chain and aprPct > 0");
  if (typeof o.hysteresisPct !== "number" || o.hysteresisPct < 0) throw new Error("watch list: hysteresisPct ≥ 0");
  if (typeof o.cooldownMin !== "number" || o.cooldownMin <= 0) throw new Error("watch list: cooldownMin > 0");
  return { wallets, ...(o.spread ? { spread: { chain: o.spread.chain, aprPct: o.spread.aprPct } } : {}), hysteresisPct: o.hysteresisPct, cooldownMin: o.cooldownMin };
}

export const loadWatchList = (path: string): WatchList => parseWatchList(JSON.parse(readFileSync(path, "utf8")));

/** Percent with 2 dp → bps, exact for the inputs a watch list holds. */
export const pctToBps = (pct: number): bigint => BigInt(Math.round(pct * 100));

export type PositionWire = Record<string, unknown>;
/** The app's /api/perpl/positions position → the risk module's raw input (same fields the app's monitor uses). */
export function toRaw(p: PositionWire): PerplPositionRaw {
  const b = (k: string) => {
    const v = p[k];
    if (typeof v !== "string" || !/^-?\d+$/.test(v)) throw new Error(`positions: bad ${k}`);
    return BigInt(v);
  };
  if (typeof p.positionType !== "number") throw new Error("positions: bad positionType");
  return { positionType: p.positionType, depositCNS: b("depositCNS"), pricePNS: b("pricePNS"), priceResiduePNSQ16: b("priceResiduePNSQ16"), lotLNS: b("lotLNS"), deltaPnlCNS: b("deltaPnlCNS"), premiumPnlCNS: b("premiumPnlCNS") };
}

export type Reading =
  | { kind: "position"; code: string; who: string; name: string; side: string; distanceBps: bigint; thresholdBps: bigint; liqPriceWad: bigint; markWad: bigint; priceDecimals: number }
  | { kind: "spread"; code: string; chain: ChainId; spreadAprWad: bigint; thresholdBps: bigint }
  | { kind: "error"; code: string; message: string };

/** Pure: one wallet's account payload → a reading per open position (Perpl's own rule via @meridian/risk). */
export function positionReadings(w: WatchList["wallets"][number], body: { positions?: PositionWire[] }): Reading[] {
  return (body.positions ?? []).map((p) => {
    const priceDecimals = Number(p.priceDecimals);
    const r = perplPositionRisk(toRaw(p), BigInt(String(p.markPNS)), { priceDecimals, lotDecimals: Number(p.lotDecimals), maintMarginHdths: BigInt(String(p.maintMarginHdths)) });
    return {
      kind: "position",
      code: `perpl_liq:${w.chain}:${w.address.toLowerCase()}:${String(p.perpId)}`,
      who: w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`,
      name: String(p.name),
      side: r.side,
      distanceBps: r.liqDistanceBps,
      thresholdBps: pctToBps(w.liqDistancePct),
      liqPriceWad: r.liqPriceWad,
      markWad: r.markWad,
      priceDecimals,
    };
  });
}

/** Pure: Meridian APR (MFI service venue) and Perpl's rate in force (app /api/perpl/market) → the spread reading. */
export function spreadReading(s: NonNullable<WatchList["spread"]>, meridianAprWad: bigint, perplRatePct100k: bigint, intervalSec: bigint): Reading {
  return { kind: "spread", code: `spread:${s.chain}`, chain: s.chain, spreadAprWad: spreadAprWad(meridianAprWad, perplAprFromPct100k(perplRatePct100k, intervalSec)), thresholdBps: pctToBps(s.aprPct) };
}

const price = (wad: bigint, pd: number) => {
  const q = wad / 10n ** BigInt(18 - pd);
  const s = q.toString().padStart(pd + 1, "0");
  return `${s.slice(0, -pd)}.${s.slice(-pd)}`;
};
const pctStr = (bps: bigint) => `${bps < 0n ? "-" : ""}${abs(bps) / 100n}.${String(abs(bps) % 100n).padStart(2, "0")}%`;
const aprBps = (wad: bigint) => (wad * 10_000n) / 10n ** 18n;

/**
 * Hysteresis: a condition starts firing when it crosses its threshold and stops only once it is `hystBps` back on
 * the safe side. `active` (codes firing) is the evaluator's state; returns the alerts to hand the pager this cycle
 * (the pager does the cooldown repeats and the RESOLVED message).
 */
export function evaluate(active: Set<string>, readings: readonly Reading[], hystBps: bigint): Alert[] {
  const out: Alert[] = [];
  for (const r of readings) {
    if (r.kind === "error") {
      out.push({ severity: "warn", code: r.code, message: r.message });
      continue;
    }
    const was = active.has(r.code);
    if (r.kind === "position") {
      const on = was ? r.distanceBps < r.thresholdBps + hystBps : r.distanceBps < r.thresholdBps;
      if (on) {
        active.add(r.code);
        out.push({
          severity: r.distanceBps * 2n < r.thresholdBps ? "critical" : "warn",
          code: r.code,
          message: `${r.who} ${r.side} ${r.name} on Perpl is ${pctStr(r.distanceBps)} from liquidation (liq ${price(r.liqPriceWad, r.priceDecimals)}, mark ${price(r.markWad, r.priceDecimals)}; alert below ${pctStr(r.thresholdBps)})`,
        });
      } else active.delete(r.code);
    } else {
      const s = abs(aprBps(r.spreadAprWad));
      const on = was ? s + hystBps > r.thresholdBps : s > r.thresholdBps;
      if (on) {
        active.add(r.code);
        out.push({ severity: "warn", code: r.code, message: `Meridian − Perpl (${r.chain === 143 ? "mainnet" : "testnet"}) funding spread ${pctStr(aprBps(r.spreadAprWad))} APR (alert above ${pctStr(r.thresholdBps)})` });
      } else active.delete(r.code);
    }
  }
  return out;
}
