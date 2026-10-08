// Money maths for the Perpl leg, bigint only, decimals from deployments/perpl.json (via core readers) and the token.
// Rounding against the user (CONTRIBUTING §2): a deposit the user owes rounds UP (and up to the on-chain minimum when it
// opens the account); an IOC buy limit rounds UP, a sell DOWN; order sizes floor to the market's size step.
import { limitFrom } from "@meridian/core/exec";
import { wadToLns, wadToPns } from "@meridian/core/perpl";

/** "12.5" → token units, rounded UP past `decimals` (owed by the user). undefined = not a plain positive decimal. */
export function parseAmountUp(input: string, decimals: number): bigint | undefined {
  const t = input.trim().replace(/,/g, "");
  const m = /^(\d{0,30})(?:\.(\d{0,36}))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return undefined;
  const whole = BigInt(m[1] || "0");
  const frac = m[2] ?? "";
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const dropped = frac.slice(decimals);
  let v = whole * 10n ** BigInt(decimals) + BigInt(kept || "0");
  if (/[1-9]/.test(dropped)) v += 1n;
  return v;
}

/** token units → "12.5" (exact, trailing zeros trimmed). */
export function formatUnitsExact(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export type DepositCheck = { ok: true; amount: bigint } | { ok: false; error: string; amount?: bigint };

/**
 * A deposit the app may send: positive, ≤ the wallet balance, and when it opens the account (createAccount) ≥ the
 * on-chain minimum read just before (getMinAccountOpenCNS). Never silently raised: below the minimum is an error the
 * screen answers with a "Use the minimum" button.
 */
export function checkDeposit(o: { amount: bigint | undefined; walletBalance: bigint | undefined; minOpen: bigint | undefined; opensAccount: boolean; decimals: number; symbol: string }): DepositCheck {
  if (o.amount === undefined || o.amount <= 0n) return { ok: false, error: `Enter an amount of ${o.symbol}` };
  if (o.opensAccount) {
    if (o.minOpen === undefined) return { ok: false, error: "Reading Perpl's minimum deposit…", amount: o.amount };
    if (o.amount < o.minOpen) return { ok: false, error: `Perpl needs at least ${formatUnitsExact(o.minOpen, o.decimals)} ${o.symbol} to open your account`, amount: o.amount };
  }
  if (o.walletBalance === undefined) return { ok: false, error: "Reading your balance…", amount: o.amount };
  if (o.amount > o.walletBalance) return { ok: false, error: `You have ${formatUnitsExact(o.walletBalance, o.decimals)} ${o.symbol}`, amount: o.amount };
  return { ok: true, amount: o.amount };
}

/** Approve only when the current allowance doesn't already cover exactly this deposit (resume after a kill mid-way). */
export const needsApprove = (allowance: bigint, amount: bigint): boolean => allowance < amount;

/** IOC worst price in PNS from a reference (best ask for a buy, best bid for a sell): buy ↑, sell ↓. */
export function iocLimitPns(refWad: bigint, side: "buy" | "sell", slippageBps: bigint, priceDecimals: number): number {
  if (refWad <= 0n) throw new RangeError("reference price must be positive");
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new RangeError("slippage must be 0–9999 bps");
  const pns = wadToPns(limitFrom(refWad, side, slippageBps), priceDecimals, side === "buy" ? "up" : "down");
  if (pns <= 0n || pns > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("limit price out of range");
  return Number(pns);
}

/** Base size (WAD) → LNS floored to the size step; 0 means below one lot. */
export function sizeLns(sizeWad: bigint, sizeDecimals: number): number {
  const l = wadToLns(sizeWad, sizeDecimals);
  if (l > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("size out of range");
  return Number(l);
}

/** The smallest order Perpl accepts: one size unit (perpl-docs exchange/minimum-orders.md: "1 MON" for MON). */
export const SMALLEST_LNS = 1;
