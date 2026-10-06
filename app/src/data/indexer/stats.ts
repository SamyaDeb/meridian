// Metrics dashboard (C5, PRD §6, DEMO_SCRIPT 2:50): numbers come from the indexer only (Envio HyperIndex GraphQL),
// each shown with the block height it's valid at. Product stats: test markets excluded; MM volume disclosed (RISKS E9).
// > VERIFY: root-field names and bigint encoding against the live `envio dev` Hasura console (indexer/SCHEMA.md).

export const STATS_QUERY = `query MeridianStats {
  ProtocolStats(where: { id: { _eq: "protocol" } }) {
    externalUsers users perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad feesWad tvlToken trades liquidations updatedBlock
  }
  Market(where: { testMarket: { _eq: false } }) {
    id symbol lastFundingBlock realizedApr1hWad realizedApr8hWad realizedApr24hWad
  }
}`;

export interface IndexerStats {
  externalUsers: number;
  users: number;
  perpVolumeQuoteWad: bigint;
  perpVolumeMmQuoteWad: bigint;
  swapVolumeWad: bigint;
  feesWad: bigint;
  tvlToken: bigint;
  trades: number;
  liquidations: number;
  /** last block that changed the protocol numbers */
  statsBlock: bigint;
  funding?: { symbol: string; block: bigint; apr1hWad?: bigint; apr8hWad?: bigint; apr24hWad?: bigint };
}

type Raw = Record<string, unknown>;

/** Hasura returns numeric columns as strings or numbers; anything else is a schema mismatch, not a zero. */
export function big(v: unknown, field: string): bigint {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "bigint") return v;
  throw new Error(`indexer: bad ${field}`);
}
export const optBig = (v: unknown, field: string) => (v === null || v === undefined ? undefined : big(v, field));
export const int = (v: unknown, field: string) => Number(big(v, field));

/** Pure: GraphQL `data` → IndexerStats. Throws on a missing/garbled ProtocolStats (the UI then says "unavailable"). */
export function parseIndexerStats(data: unknown): IndexerStats {
  const d = (data ?? {}) as { ProtocolStats?: Raw[]; Market?: Raw[] };
  const p = d.ProtocolStats?.[0];
  if (!p) throw new Error("indexer: no ProtocolStats yet");
  const markets = d.Market ?? [];
  // single product perp at launch; if several, the most recently funded one leads the headline
  const m = [...markets].sort((a, b) => (big(b.lastFundingBlock, "lastFundingBlock") > big(a.lastFundingBlock, "lastFundingBlock") ? 1 : -1))[0];
  return {
    externalUsers: int(p.externalUsers, "externalUsers"),
    users: int(p.users, "users"),
    perpVolumeQuoteWad: big(p.perpVolumeQuoteWad, "perpVolumeQuoteWad"),
    perpVolumeMmQuoteWad: big(p.perpVolumeMmQuoteWad, "perpVolumeMmQuoteWad"),
    swapVolumeWad: big(p.swapVolumeWad, "swapVolumeWad"),
    feesWad: big(p.feesWad, "feesWad"),
    tvlToken: big(p.tvlToken, "tvlToken"),
    trades: int(p.trades, "trades"),
    liquidations: int(p.liquidations, "liquidations"),
    statsBlock: big(p.updatedBlock, "updatedBlock"),
    ...(m
      ? {
          funding: {
            symbol: String(m.symbol ?? "MON-PERP"),
            block: big(m.lastFundingBlock, "lastFundingBlock"),
            apr1hWad: optBig(m.realizedApr1hWad, "realizedApr1hWad"),
            apr8hWad: optBig(m.realizedApr8hWad, "realizedApr8hWad"),
            apr24hWad: optBig(m.realizedApr24hWad, "realizedApr24hWad"),
          },
        }
      : {}),
  };
}

/** MM share of perp volume in basis points (0 when there is no volume), rounds down. */
export function mmShareBps(totalWad: bigint, mmWad: bigint): number {
  if (totalWad <= 0n) return 0;
  return Number((mmWad * 10_000n) / totalWad);
}

/** POST a GraphQL query to the indexer; returns `data` or throws (HTTP error, GraphQL error). */
export async function postGql(url: string, query: string, variables: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    signal,
  });
  if (!res.ok) throw new Error(`indexer: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0]!.message}`);
  return body.data;
}

export async function fetchIndexerStats(url: string, signal?: AbortSignal): Promise<IndexerStats> {
  return parseIndexerStats(await postGql(url, STATS_QUERY, undefined, signal));
}
