// Perpl (another Monad perp, K2.2) from the same indexer: its MON market, funding per interval and liquidations, on
// any chain the indexer covers (10143 next to Meridian; 143 = mainnet Perpl, K2.3). Positions are indexed only by the
// "full" profile (indexer/scripts/gen-config.mjs PERPL_PROFILES); the hosted lean profile leaves PerplPosition empty,
// and a single trader's live position is better read from the exchange's getPosition view (K5).
import perplRecord from "../../../../deployments/perpl.json";
import { big, int, optBig, postGql } from "./stats";
import { type Raw, bool, rows, str, optStr } from "./rows";

export type PerplMarket = {
  perpId: bigint;
  name?: string;
  isMon: boolean;
  lastAprWad?: bigint;
  lastRatePct100k?: bigint;
  lastFundingEventBlock?: bigint;
  lastMarkWad?: bigint;
  liquidations: number;
};
export type PerplFunding = { fundingEventBlock: bigint; ratePct100k: bigint; aprWad?: bigint; fundingPriceWad?: bigint; timestamp: bigint };
export type PerplLiquidation = {
  accountId: bigint;
  address?: string;
  side: "Long" | "Short";
  liqLots: bigint;
  markPriceWad?: bigint;
  liqPriceWad?: bigint;
  block: bigint;
  timestamp: bigint;
  txHash: string;
};

/** Perpl's MON market per chain, from deployments/perpl.json (seeded from Perpl's context endpoint; never guessed). */
export function perplMonId(chainId: number): number | undefined {
  const c = (perplRecord.chains as Record<string, { monMarketId?: number }>)[String(chainId)];
  return typeof c?.monMarketId === "number" ? c.monMarketId : undefined;
}

/** The MON perp id is inlined (an integer from our own record), so the BigInt column needs no variable type. */
export const perplQuery = (monPerpId: number) => {
  if (!Number.isSafeInteger(monPerpId) || monPerpId < 0) throw new Error("bad perp id");
  return `query MeridianPerpl($chainId: Int!, $limit: Int!) {
  PerplMarket(where: { chainId: { _eq: $chainId }, perpId: { _eq: "${monPerpId}" } }, limit: 1) {
    perpId name isMon lastAprWad lastRatePct100k lastFundingEventBlock lastMarkWad liquidations
  }
  PerplFunding(where: { chainId: { _eq: $chainId }, perpId: { _eq: "${monPerpId}" } }, order_by: { fundingEventBlock: desc }, limit: $limit) {
    perpId fundingEventBlock ratePct100k aprWad fundingPriceWad timestamp
  }
  PerplLiquidation(where: { chainId: { _eq: $chainId }, perpId: { _eq: "${monPerpId}" } }, order_by: { block: desc }, limit: $limit) {
    perpId accountId address side liqLots markPriceWad liqPriceWad block timestamp txHash
  }
}`;
};

const perpOf = (r: Raw) => big(r.perpId, "perpId");

/** Pure: the MON market, its funding history (oldest first) and recent MON liquidations (newest first). */
export function parsePerpl(data: unknown, monPerpId: number): { mon?: PerplMarket; funding: PerplFunding[]; liquidations: PerplLiquidation[] } {
  const m = rows(data, "PerplMarket")[0];
  const mon: PerplMarket | undefined = m
    ? {
        perpId: perpOf(m),
        ...(optStr(m.name, "name") ? { name: optStr(m.name, "name")! } : {}),
        isMon: bool(m.isMon, "isMon"),
        ...pick(m, ["lastAprWad", "lastRatePct100k", "lastFundingEventBlock", "lastMarkWad"]),
        liquidations: int(m.liquidations, "liquidations"),
      }
    : undefined;
  const onMon = (r: Raw) => perpOf(r) === BigInt(monPerpId); // the query filters already; a stray row is dropped
  const funding = rows(data, "PerplFunding")
    .filter(onMon)
    .map((r) => ({
      fundingEventBlock: big(r.fundingEventBlock, "fundingEventBlock"),
      ratePct100k: big(r.ratePct100k, "ratePct100k"),
      timestamp: big(r.timestamp, "timestamp"),
      ...pick(r, ["aprWad", "fundingPriceWad"]),
    }))
    .sort((a, b) => (a.fundingEventBlock < b.fundingEventBlock ? -1 : 1));
  const liquidations = rows(data, "PerplLiquidation")
    .filter(onMon)
    .map((r) => {
      const side = str(r.side, "side");
      if (side !== "Long" && side !== "Short") throw new Error("indexer: bad side");
      const address = optStr(r.address, "address");
      return {
        accountId: big(r.accountId, "accountId"),
        ...(address ? { address } : {}),
        side,
        liqLots: big(r.liqLots, "liqLots"),
        ...pick(r, ["markPriceWad", "liqPriceWad"]),
        block: big(r.block, "block"),
        timestamp: big(r.timestamp, "timestamp"),
        txHash: str(r.txHash, "txHash"),
      } as PerplLiquidation;
    });
  return { ...(mon ? { mon } : {}), funding, liquidations };
}

function pick<K extends string>(r: Raw, keys: readonly K[]): Partial<Record<K, bigint>> {
  const out: Partial<Record<K, bigint>> = {};
  for (const k of keys) {
    const v = optBig(r[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Undefined when deployments/perpl.json has no MON market for `chainId`. */
export async function fetchPerpl(url: string, chainId: number, limit: number, signal?: AbortSignal) {
  const mon = perplMonId(chainId);
  if (mon === undefined) return undefined;
  return parsePerpl(await postGql(url, perplQuery(mon), { chainId, limit }, signal), mon);
}
