// Pure Meridian risk summary for Rates & Risk (K5 step 4): users' liquidation-distance histogram with operators taken
// out (MM, house flow, keepers: deployments `_operators`, as ProtocolStats does), OI by side and skew, and the MM's
// share of open interest, disclosed.
import { histogram, type OpenPos } from "@/lib/liqDistance";

const BPS = 10_000n;

export type MeridianRisk = {
  histogram: ReturnType<typeof histogram>;
  /** distinct non-operator accounts with an open position (positions without an account count as users) */
  users: number;
  operatorPositions: number;
  longWad: bigint;
  shortWad: bigint;
  /** (long − short) / (long + short), bps, rounds toward zero; + = more longs */
  skewBps: bigint;
  mmLongWad: bigint;
  mmShortWad: bigint;
  /** MM size / all open size (both sides), bps, rounds down */
  mmShareBps: bigint;
};

export function meridianRisk(ps: readonly OpenPos[], markWad: bigint, mmrWad: bigint, operators: { mm: readonly string[]; all: readonly string[] }, oi?: { longWad: bigint; shortWad: bigint }): MeridianRisk {
  const isOp = (p: OpenPos) => p.account !== undefined && operators.all.includes(p.account);
  const isMm = (p: OpenPos) => p.account !== undefined && operators.mm.includes(p.account);
  const open = ps.filter((p) => p.size !== 0n);
  const users = open.filter((p) => !isOp(p));
  let longWad = 0n;
  let shortWad = 0n;
  let mmLongWad = 0n;
  let mmShortWad = 0n;
  for (const p of open) {
    if (p.size > 0n) longWad += p.size;
    else shortWad += -p.size;
    if (isMm(p)) {
      if (p.size > 0n) mmLongWad += p.size;
      else mmShortWad += -p.size;
    }
  }
  // the market's own OI (contract / indexer Market row) wins over the sum of mirrored rows when it is known
  if (oi) {
    longWad = oi.longWad;
    shortWad = oi.shortWad;
  }
  const total = longWad + shortWad;
  return {
    histogram: histogram(users, markWad, mmrWad),
    users: new Set(users.map((p, i) => p.account ?? `#${i}`)).size,
    operatorPositions: open.length - users.length,
    longWad,
    shortWad,
    skewBps: total > 0n ? ((longWad - shortWad) * BPS) / total : 0n,
    mmLongWad,
    mmShortWad,
    mmShareBps: total > 0n ? ((mmLongWad + mmShortWad) * BPS) / total : 0n,
  };
}

/** Insurance-fund balance after the latest waterfall step (InsuranceFundEvent.balanceAfterToken), oldest-first input. */
export const latestIfBalance = (steps: readonly { balanceAfterToken: bigint }[]): bigint | undefined => steps.at(-1)?.balanceAfterToken;
