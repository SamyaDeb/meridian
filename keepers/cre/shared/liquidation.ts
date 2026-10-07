// W1 liquidation guardian: candidate sourcing and selection. Pure, bigint only; unit-tested in test/liquidation.test.ts.
// Candidates come from bounded sources (never a global scan): recent PositionChanged logs, an optional indexer query
// and a configured watch list. Each is CONFIRMED onchain with getAccount before it goes into a report.
import { getAddress, isAddress, type Address } from "viem";
import { MAX_BATCH } from "./report";

/** Subset of IClearingHouse.AccountView. */
export type AccountSnapshot = {
  account: Address;
  size: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  liquidatable: boolean;
};

/** Distinct, checksummed, never the receiver itself (liquidate() reverts on self-liquidation), at most `max`. */
export function mergeCandidates(sources: ReadonlyArray<readonly string[]>, receiver: Address, max: number): Address[] {
  const self = receiver.toLowerCase();
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const list of sources) {
    for (const a of list) {
      if (!isAddress(a, { strict: false })) continue;
      const k = a.toLowerCase();
      if (k === self || seen.has(k)) continue;
      seen.add(k);
      out.push(getAddress(a));
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Accounts whose latest PositionChanged in the window left them with a position (chain order in, last write wins). */
export function openFromPositionChanges(changes: ReadonlyArray<{ account: string; newSize: bigint }>): string[] {
  const last = new Map<string, bigint>();
  for (const c of changes) last.set(c.account.toLowerCase(), c.newSize);
  return [...last].filter(([, s]) => s !== 0n).map(([a]) => a);
}

/** Envio AccountMarket rows (docs: indexer/SCHEMA.md) for one market with a non-zero size. */
export function parseIndexerAccounts(body: unknown, market: Address): string[] {
  const rows = (body as { data?: { AccountMarket?: unknown } })?.data?.AccountMarket;
  if (!Array.isArray(rows)) return [];
  const m = market.toLowerCase();
  const out: string[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = typeof r.id === "string" ? r.id : "";
    const [mk, acct] = id.split("-");
    const size = typeof r.size === "string" ? r.size : "0";
    if (mk?.toLowerCase() === m && acct && size !== "0") out.push(acct);
  }
  return out;
}

export function indexerQuery(market: Address, limit: number): string {
  return JSON.stringify({
    query: `query($m: String!, $n: Int!) { AccountMarket(where: { market_id: { _eq: $m }, size: { _neq: "0" } }, limit: $n) { id size } }`,
    variables: { m: getAddress(market), n: limit },
  });
}

function shortfall(a: AccountSnapshot): bigint {
  return a.equity >= a.maintenanceMargin ? 0n : a.maintenanceMargin - a.equity;
}
function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Accounts the ClearingHouse reports liquidatable, most under water first (ties: larger |size|, then address), at most
 * MAX_BATCH. The receiver sizes each take to its own headroom onchain, so the order only decides who goes first.
 */
export function selectLiquidations(snaps: readonly AccountSnapshot[], max = MAX_BATCH): Address[] {
  return snaps
    .filter((s) => s.liquidatable && s.size !== 0n)
    .sort((x, y) => {
      const a = shortfall(x);
      const b = shortfall(y);
      if (a !== b) return a > b ? -1 : 1;
      const sx = abs(x.size);
      const sy = abs(y.size);
      if (sx !== sy) return sx > sy ? -1 : 1;
      return x.account.toLowerCase() < y.account.toLowerCase() ? -1 : 1;
    })
    .slice(0, Math.min(max, MAX_BATCH))
    .map((s) => s.account);
}

/** UNWIND is worth a report when the receiver holds at least one lot (a smaller remainder can't trade). */
export function shouldUnwind(receiverSize: bigint, lotSize: bigint): boolean {
  return lotSize > 0n && abs(receiverSize) >= lotSize;
}
