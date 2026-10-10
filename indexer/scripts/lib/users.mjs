// K6 B3: user and product metrics from the indexer, shared by scripts/users-report.mjs and its tests (and mirrored by
// the app's /stats reader). Pure: GraphQL `data` in, numbers out. Operators are excluded twice: by the indexer
// (Account.countedExternal is false for deployments' mmAccounts / keeperAccounts / owner) and here by a labelled list of
// our own test wallets (demo victim, Privy test accounts, CRE wallet …) that the deployments file doesn't name.

/** One query, one chain. Lists are capped (rule 5: bounded reads); a capped list is reported as "≥ n". */
export const LIMIT = 1000;
export const METRICS_QUERY = `query MeridianMetrics($chainId: Int!) {
  ProtocolStats(where: { chainId: { _eq: $chainId }, id: { _eq: "protocol" } }) {
    externalUsers users perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad trades liquidations tvlToken vaultNavToken updatedBlock
  }
  Market(where: { chainId: { _eq: $chainId } }) { id symbol testMarket }
  Account(where: { chainId: { _eq: $chainId }, countedExternal: { _eq: true } }, order_by: { firstSeenBlock: asc }, limit: ${LIMIT}) {
    id firstSeenBlock tradeCount volumeQuoteWad
  }
  Liquidation(where: { chainId: { _eq: $chainId }, kind: { _eq: "Perp" } }, order_by: { block: desc }, limit: ${LIMIT}) { market account }
  SwapPosition(where: { chainId: { _eq: $chainId } }, limit: ${LIMIT}) { account_id }
  VaultUser(where: { chainId: { _eq: $chainId } }, limit: ${LIMIT}) { user depositedToken }
  VaultRedeemRequest(where: { chainId: { _eq: $chainId } }, limit: ${LIMIT}) { owner status }
}`;
export const HEAD_QUERY = `query MeridianHead { chain_metadata { chain_id latest_processed_block block_height } }`;

const arr = (d, k) => {
  const v = d?.[k];
  if (!Array.isArray(v)) throw new Error(`indexer: no ${k} field`);
  return v;
};
const big = (v, k) => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`indexer: bad ${k}`);
};
const lc = (a) => String(a).toLowerCase();

/**
 * @param {unknown} data METRICS_QUERY response `data`
 * @param {unknown} head HEAD_QUERY response `data` (optional)
 * @param {{ chainId: number, testWallets?: string[] }} o
 */
export function computeMetrics(data, head, o) {
  const p = arr(data, "ProtocolStats")[0];
  if (!p) throw new Error("indexer: no ProtocolStats yet");
  const test = new Set((o.testWallets ?? []).map(lc));
  const testMarkets = new Set(arr(data, "Market").filter((m) => m.testMarket === true).map((m) => lc(m.id)));
  const accounts = arr(data, "Account");
  const ext = new Set(accounts.map((a) => lc(a.id)).filter((a) => !test.has(a)));
  const isExt = (a) => ext.has(lc(a));
  const liq = arr(data, "Liquidation");
  const swaps = arr(data, "SwapPosition");
  const vu = arr(data, "VaultUser");
  const rq = arr(data, "VaultRedeemRequest");
  const capped = (xs) => xs.length >= LIMIT;
  const status = (s) => rq.filter((r) => isExt(r.owner) && r.status === s).length;
  const vaultExt = vu.filter((u) => isExt(u.user) && big(u.depositedToken, "depositedToken") > 0n);
  const metaRow = head ? arr(head, "chain_metadata").find((c) => Number(c.chain_id) === o.chainId) : undefined;
  const asOfBlock = metaRow ? big(String(metaRow.latest_processed_block), "latest_processed_block") : big(p.updatedBlock, "updatedBlock");
  const volume = big(p.perpVolumeQuoteWad, "perpVolumeQuoteWad");
  const mmVolume = big(p.perpVolumeMmQuoteWad, "perpVolumeMmQuoteWad");
  return {
    chainId: o.chainId,
    asOfBlock,
    statsBlock: big(p.updatedBlock, "updatedBlock"),
    /** indexer's count (operators from deployments excluded) */
    externalUsersIndexer: Number(big(p.externalUsers, "externalUsers")),
    /** the same accounts minus our labelled test wallets */
    externalUsers: ext.size,
    externalUsersCapped: capped(accounts),
    testWalletsExcluded: accounts.filter((a) => test.has(lc(a.id))).length,
    allAccounts: Number(big(p.users, "users")),
    trades: Number(big(p.trades, "trades")),
    externalTraders: accounts.filter((a) => !test.has(lc(a.id)) && Number(a.tradeCount) > 0).length,
    perpVolumeQuoteWad: volume,
    perpVolumeMmQuoteWad: mmVolume,
    mmShareBps: volume > 0n ? Number((mmVolume * 10_000n) / volume) : 0,
    swapVolumeWad: big(p.swapVolumeWad, "swapVolumeWad"),
    swapsOpenedExternal: swaps.filter((s) => isExt(s.account_id)).length,
    swapsOpenedAll: swaps.length,
    vaultDepositorsExternal: vaultExt.length,
    vaultDepositedTokenExternal: vaultExt.reduce((x, u) => x + big(u.depositedToken, "depositedToken"), 0n),
    redeems: { requested: status("Pending"), claimable: status("Claimable"), claimed: status("Claimed"), cancelled: status("Cancelled") },
    liquidationsProduct: liq.filter((l) => !testMarkets.has(lc(l.market))).length,
    liquidationsTestMarket: liq.filter((l) => testMarkets.has(lc(l.market))).length,
    liquidationsCapped: capped(liq),
    tvlToken: big(p.tvlToken, "tvlToken"),
  };
}

const fmt = (wad, dec = 18, dp = 2) => {
  const neg = wad < 0n;
  const a = neg ? -wad : wad;
  const s = (a * 10n ** BigInt(dp)) / 10n ** BigInt(dec);
  const str = s.toString().padStart(dp + 1, "0");
  return `${neg ? "-" : ""}${str.slice(0, -dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${str.slice(-dp)}`;
};

/** Markdown for docs/outputs/USERS.md. Addresses appear only for accounts with recorded consent. */
export function usersMarkdown(m, o) {
  const consent = new Set((o.consented ?? []).map(lc));
  const listed = (o.accounts ?? []).filter((a) => consent.has(lc(a)));
  const ge = (n, c) => (c ? `≥ ${n}` : String(n));
  return [
    `### Users (chain ${m.chainId}, indexer as of block ${m.asOfBlock}; stats last changed at block ${m.statsBlock})`,
    "",
    "| metric | value |",
    "|---|---:|",
    `| external users (operators and our ${m.testWalletsExcluded} labelled test wallet(s) excluded) | ${ge(m.externalUsers, m.externalUsersCapped)} |`,
    `| of which traded the perp | ${m.externalTraders} |`,
    `| all accounts incl. ours | ${m.allAccounts} |`,
    `| perp trades (all) | ${m.trades} |`,
    `| perp volume (AUSD) · our MM's share | ${fmt(m.perpVolumeQuoteWad)} · ${(m.mmShareBps / 100).toFixed(1)}% |`,
    `| funding swaps opened by external users (all) | ${m.swapsOpenedExternal} (${m.swapsOpenedAll}) |`,
    `| vault depositors (external) · deposited AUSD | ${m.vaultDepositorsExternal} · ${fmt(m.vaultDepositedTokenExternal, 6)} |`,
    `| vault withdrawal requests (external): requested / claimable / claimed / cancelled | ${m.redeems.requested} / ${m.redeems.claimable} / ${m.redeems.claimed} / ${m.redeems.cancelled} |`,
    `| liquidations: product market · labelled demo market | ${ge(m.liquidationsProduct, m.liquidationsCapped)} · ${m.liquidationsTestMarket} |`,
    `| TVL (AUSD) | ${fmt(m.tvlToken, 6)} |`,
    "",
    listed.length ? `Users who agreed to be listed: ${listed.join(", ")}` : "No user has agreed to be listed by address.",
    "",
  ].join("\n");
}
