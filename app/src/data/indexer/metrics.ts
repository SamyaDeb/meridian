// K6 B3: /stats user and product metrics from the indexer. Same query and rules as indexer/scripts/lib/users.mjs
// (the CLI that prints docs/outputs/USERS.md); metrics.test.ts checks both give the same numbers on one fixture.
// Operators are excluded by the indexer (Account.countedExternal); our labelled test wallets are subtracted here.
import { big, postGql } from "./stats";
import { rows } from "./rows";

export const METRICS_LIMIT = 1000;
export const METRICS_QUERY = `query MeridianMetrics($chainId: Int!) {
  ProtocolStats(where: { chainId: { _eq: $chainId }, id: { _eq: "protocol" } }) {
    externalUsers users perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad trades liquidations tvlToken vaultNavToken updatedBlock
  }
  Market(where: { chainId: { _eq: $chainId } }) { id symbol testMarket }
  Account(where: { chainId: { _eq: $chainId }, countedExternal: { _eq: true } }, order_by: { firstSeenBlock: asc }, limit: ${METRICS_LIMIT}) {
    id firstSeenBlock tradeCount volumeQuoteWad
  }
  Liquidation(where: { chainId: { _eq: $chainId }, kind: { _eq: "Perp" } }, order_by: { block: desc }, limit: ${METRICS_LIMIT}) { market account }
  SwapPosition(where: { chainId: { _eq: $chainId } }, limit: ${METRICS_LIMIT}) { account_id }
  VaultUser(where: { chainId: { _eq: $chainId } }, limit: ${METRICS_LIMIT}) { user depositedToken }
  VaultRedeemRequest(where: { chainId: { _eq: $chainId } }, limit: ${METRICS_LIMIT}) { owner status }
}`;
export const HEAD_QUERY = `query MeridianHead { chain_metadata { chain_id latest_processed_block block_height } }`;

/**
 * Our own wallets that deployments' operator lists don't name (docs/outputs/test-wallets.json): the Privy test
 * account, the labelled demo victim, the CRE wallet and receiver, test wallets A and B. Never users.
 */
export const TEST_WALLETS: readonly string[] = [
  "0x5c2dBeB734bEe60c2Db8aaFA249AA6614506Cc5B",
  "0x80e511c00Ff854c1D91de1481D264F309520aE7E",
  "0xb624c6144aA825f22452B3cEFC3728F38b0c088c",
  "0x7c44C263225706fE28809BaE9fCC13460A908932",
  "0x6d2d29981f9682894a10DCbA4604107449c658b7",
  "0x6058311F2418e5ed98547DaA442A52cf971735f4",
];

export interface Metrics {
  asOfBlock: bigint;
  statsBlock: bigint;
  externalUsers: number;
  externalUsersCapped: boolean;
  testWalletsExcluded: number;
  externalTraders: number;
  trades: number;
  perpVolumeQuoteWad: bigint;
  perpVolumeMmQuoteWad: bigint;
  mmShareBps: number;
  swapsOpenedExternal: number;
  swapsOpenedAll: number;
  vaultDepositorsExternal: number;
  vaultDepositedTokenExternal: bigint;
  redeems: { requested: number; claimable: number; claimed: number; cancelled: number };
  liquidationsProduct: number;
  liquidationsTestMarket: number;
  liquidationsCapped: boolean;
}

const lc = (a: unknown) => String(a).toLowerCase();

/** Pure: METRICS_QUERY `data` (+ HEAD_QUERY `data`) → Metrics. Throws on a missing or garbled field. */
export function parseMetrics(data: unknown, head: unknown, chainId: number, testWallets: readonly string[] = TEST_WALLETS): Metrics {
  const p = rows(data, "ProtocolStats")[0];
  if (!p) throw new Error("indexer: no ProtocolStats yet");
  const test = new Set(testWallets.map(lc));
  const testMarkets = new Set(rows(data, "Market").filter((m) => m.testMarket === true).map((m) => lc(m.id)));
  const accounts = rows(data, "Account");
  const ext = new Set(accounts.map((a) => lc(a.id)).filter((a) => !test.has(a)));
  const isExt = (a: unknown) => ext.has(lc(a));
  const liq = rows(data, "Liquidation");
  const swaps = rows(data, "SwapPosition");
  const vu = rows(data, "VaultUser");
  const rq = rows(data, "VaultRedeemRequest");
  const status = (s: string) => rq.filter((r) => isExt(r.owner) && r.status === s).length;
  const vaultExt = vu.filter((u) => isExt(u.user) && big(u.depositedToken, "depositedToken") > 0n);
  const meta = head ? rows(head, "chain_metadata").find((c) => Number(c.chain_id) === chainId) : undefined;
  const statsBlock = big(p.updatedBlock, "updatedBlock");
  const volume = big(p.perpVolumeQuoteWad, "perpVolumeQuoteWad");
  const mmVolume = big(p.perpVolumeMmQuoteWad, "perpVolumeMmQuoteWad");
  return {
    asOfBlock: meta ? big(String(meta.latest_processed_block), "latest_processed_block") : statsBlock,
    statsBlock,
    externalUsers: ext.size,
    externalUsersCapped: accounts.length >= METRICS_LIMIT,
    testWalletsExcluded: accounts.filter((a) => test.has(lc(a.id))).length,
    externalTraders: accounts.filter((a) => !test.has(lc(a.id)) && Number(a.tradeCount) > 0).length,
    trades: Number(big(p.trades, "trades")),
    perpVolumeQuoteWad: volume,
    perpVolumeMmQuoteWad: mmVolume,
    mmShareBps: volume > 0n ? Number((mmVolume * 10_000n) / volume) : 0,
    swapsOpenedExternal: swaps.filter((s) => isExt(s.account_id)).length,
    swapsOpenedAll: swaps.length,
    vaultDepositorsExternal: vaultExt.length,
    vaultDepositedTokenExternal: vaultExt.reduce((x, u) => x + big(u.depositedToken, "depositedToken"), 0n),
    redeems: { requested: status("Pending"), claimable: status("Claimable"), claimed: status("Claimed"), cancelled: status("Cancelled") },
    liquidationsProduct: liq.filter((l) => !testMarkets.has(lc(l.market))).length,
    liquidationsTestMarket: liq.filter((l) => testMarkets.has(lc(l.market))).length,
    liquidationsCapped: liq.length >= METRICS_LIMIT,
  };
}

export async function fetchMetrics(url: string, chainId: number, signal?: AbortSignal): Promise<Metrics> {
  const [data, head] = await Promise.all([postGql(url, METRICS_QUERY, { chainId }, signal), postGql(url, HEAD_QUERY, undefined, signal)]);
  return parseMetrics(data, head, chainId);
}
