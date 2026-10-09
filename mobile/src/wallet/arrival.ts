// Deposit arrival (MOBILE_UX_RESEARCH §5.1 / M4): compare two consecutive BalanceReader states and name what went up.
// Pure: the first read, an unknown value on either side, or a read error never counts as an arrival.
import { formatValue } from "../ui/format";
import { toWad, type BalanceState } from "./balances";

export type Arrival = {
  /** "AUSD" or "MON" */
  symbol: "AUSD" | "MON";
  /** the balance line that rose (e.g. "Test AUSD (Meridian)"), for screen readers and the sheet */
  label: string;
  /** increase in WAD (exact for ≤ 18 decimals) */
  amountWad: bigint;
};

const MON_DECIMALS = 18;

export function detectArrival(prev: BalanceState | undefined, next: BalanceState): Arrival[] {
  if (!prev || next.error !== undefined) return [];
  if (prev.block !== undefined && next.block !== undefined && next.block <= prev.block) return [];
  const out: Arrival[] = [];
  for (const t of next.tokens) {
    const before = prev.tokens.find((p) => p.label === t.label);
    if (before?.amount === undefined || t.amount === undefined || t.decimals === undefined) continue;
    if (t.amount > before.amount) out.push({ symbol: "AUSD", label: t.label, amountWad: toWad(t.amount - before.amount, t.decimals) });
  }
  if (prev.mon !== undefined && next.mon !== undefined && next.mon > prev.mon) out.push({ symbol: "MON", label: "MON", amountWad: toWad(next.mon - prev.mon, MON_DECIMALS) });
  return out;
}

/** "+12.50 AUSD arrived" (MON gets 4 decimals: fee-sized amounts would read "+0.00"). */
export const arrivalText = (a: Arrival): string => `${formatValue(a.amountWad, "usd", { dp: a.symbol === "MON" ? 4 : 2, signed: true })} ${a.symbol} arrived`;

/** Wallet AUSD across the balance lines, WAD; undefined until every line is known. */
export function walletAusdWad(state: BalanceState | undefined): bigint | undefined {
  if (!state) return undefined;
  let sum = 0n;
  for (const t of state.tokens) {
    if (t.amount === undefined || t.decimals === undefined) return undefined;
    sum += toWad(t.amount, t.decimals);
  }
  return sum;
}
