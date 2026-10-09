"use client";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useDataSource } from "./context";
import type { Address, Market } from "./types";
import type { FundingSettlement } from "./chain/source";
import type { FundingWindow } from "./indexer/funding";
import { BLOCK_TIME_MS } from "@/lib/units";
import { MOCK } from "./mock/fixtures";
import { fetchIndexerStats } from "./indexer/stats";

// Per-block data refreshes every block (300 ms); the rest every few seconds.
// WS-07 task 2: on testnet/mainnet useFundingTicker switches to a WSS newHeads subscription + previewFundingState().
const PER_BLOCK = BLOCK_TIME_MS;
const SLOW = 5_000;

/** Chain the indexer rows are read for (the indexer also holds Perpl mainnet rows): NEXT_PUBLIC_CHAIN_ID, as the read path. */
export const INDEXER_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337");

/**
 * Live market (per block, data source) with the realized-APR windows from the indexer's FundingWindow when it is
 * connected (K2.4: 1 h / 8 h / 24 h / 7 d computed once in the indexer, the same ΔF/ΔG as averageFundingApr). A
 * window the indexer has no history for falls back to the data source's own value.
 */
export function useMarket() {
  const ds = useDataSource();
  const q = useQuery({ queryKey: ["market", ds.kind, ds.marketKey], queryFn: () => ds.market(), refetchInterval: PER_BLOCK });
  const { data: fw } = useFundingWindow(q.data?.clearingHouse);
  if (!q.data || !fw) return q;
  return { ...q, data: withFundingWindow(q.data, fw) } as typeof q;
}

/** Pure: indexer windows over the data source's (an indexer `null` keeps the source value). */
export function withFundingWindow(m: Market, fw: FundingWindow): Market {
  return {
    ...m,
    realizedApr1hWad: fw.apr1hWad ?? m.realizedApr1hWad,
    realizedApr8hWad: fw.apr8hWad ?? m.realizedApr8hWad,
    realizedApr24hWad: fw.apr24hWad ?? m.realizedApr24hWad,
    ...(fw.apr7dWad !== undefined ? { realizedApr7dWad: fw.apr7dWad } : {}),
  };
}

/** Indexer FundingWindow of `market` (off without NEXT_PUBLIC_INDEXER_URL). */
export function useFundingWindow(market: Address | undefined) {
  return useQuery({
    queryKey: ["fundingWindow", INDEXER_URL, INDEXER_CHAIN_ID, market],
    queryFn: async ({ signal }) => (await import("./indexer/funding")).fetchFundingWindow(INDEXER_URL!, INDEXER_CHAIN_ID, market!, signal),
    enabled: INDEXER_URL !== undefined && market !== undefined,
    refetchInterval: SLOW,
    retry: 1,
  });
}

/** Hourly Meridian realized 1 h APR vs Perpl MON funding (indexer CrossVenueFunding), oldest first. */
export function useCrossVenueFunding(hours = 72) {
  return useQuery({
    queryKey: ["crossVenue", INDEXER_URL, INDEXER_CHAIN_ID, hours],
    queryFn: async ({ signal }) => (await import("./indexer/funding")).fetchCrossVenue(INDEXER_URL!, INDEXER_CHAIN_ID, hours, signal),
    enabled: INDEXER_URL !== undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** Perpl's MON market, funding history and liquidations on `chainId` (10143 next to Meridian, 143 = mainnet). */
export function usePerpl(chainId: number = INDEXER_CHAIN_ID, limit = 100) {
  return useQuery({
    queryKey: ["perpl", INDEXER_URL, chainId, limit],
    queryFn: async ({ signal }) => (await import("./indexer/perpl")).fetchPerpl(INDEXER_URL!, chainId, limit, signal),
    enabled: INDEXER_URL !== undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** One row per UTC day (ProtocolDaily), oldest first. */
export function useProtocolDaily(days = 30) {
  return useQuery({
    queryKey: ["protocolDaily", INDEXER_URL, INDEXER_CHAIN_ID, days],
    queryFn: async ({ signal }) => (await import("./indexer/protocol")).fetchProtocolDaily(INDEXER_URL!, INDEXER_CHAIN_ID, days, signal),
    enabled: INDEXER_URL !== undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** Insurance-fund waterfall steps (InsuranceFundEvent), in order. */
export function useInsuranceFlows(limit = 100) {
  return useQuery({
    queryKey: ["insuranceFlows", INDEXER_URL, INDEXER_CHAIN_ID, limit],
    queryFn: async ({ signal }) => (await import("./indexer/protocol")).fetchInsurance(INDEXER_URL!, INDEXER_CHAIN_ID, limit, signal),
    enabled: INDEXER_URL !== undefined,
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** All-time totals of the connected account (realized PnL, funding paid, fees, liquidations) + vault requests. */
export function usePortfolio(account: Address) {
  const { isConnected } = useAccount();
  return useQuery({
    queryKey: ["portfolio", INDEXER_URL, INDEXER_CHAIN_ID, account],
    queryFn: async ({ signal }) => (await import("./indexer/portfolio")).fetchPortfolio(INDEXER_URL!, INDEXER_CHAIN_ID, account, signal),
    enabled: INDEXER_URL !== undefined && isConnected,
    refetchInterval: SLOW,
    retry: 1,
  });
}

export function useFundingTicks(limit = 300) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["fundingTicks", ds.kind, ds.marketKey, limit], queryFn: () => ds.fundingTicks(limit), refetchInterval: PER_BLOCK });
}

export function useDepth(levels = 6) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["depth", ds.kind, ds.marketKey, levels], queryFn: () => ds.depth(levels), refetchInterval: 1_000 });
}

export function useTrades(limit = 12) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["trades", ds.kind, ds.marketKey, limit], queryFn: () => ds.trades(limit), refetchInterval: 1_000 });
}

/** The connected wallet; the mock account stands in when nothing is connected (mock data layer). */
export function useAccountAddress(): Address {
  const { address } = useAccount();
  return address ?? MOCK.user;
}

/** Resting orders of `account` (chain data source only). */
export function useOpenOrders(account: Address) {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  return useQuery({
    enabled: ds.kind === "mock" || isConnected, // chain mode: a connected wallet only
    queryKey: ["openOrders", ds.kind, ds.marketKey, account],
    queryFn: () => ("openOrders" in ds ? (ds as import("./chain/source").ChainSource).openOrders(account) : Promise.resolve([])),
    refetchInterval: 1_000,
  });
}

export function usePositions(account: Address) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["positions", ds.kind, ds.marketKey, account], queryFn: () => ds.positions(account), refetchInterval: SLOW });
}

/** Indexer vault totals + share-price history (whole history, K2.4); off without the indexer or a vault address. */
function useVaultHistory(vault: Address | undefined, limit: number) {
  return useQuery({
    queryKey: ["vaultHistory", INDEXER_URL, INDEXER_CHAIN_ID, vault, limit],
    queryFn: async ({ signal }) => (await import("./indexer/vault")).fetchVaultHistory(INDEXER_URL!, INDEXER_CHAIN_ID, vault!, limit, signal),
    enabled: INDEXER_URL !== undefined && vault !== undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/**
 * Live vault (contract views) with the history-shaped numbers from the indexer when connected: deposits, withdrawals
 * and users since launch, and the 24 h / 7 d APY from hourly share prices (the chain source can only see its log
 * window, so its totals and APY cover minutes, not the vault's life).
 */
export function useVault() {
  const ds = useDataSource();
  const q = useQuery({ queryKey: ["vault", ds.kind, ds.marketKey], queryFn: () => ds.vault(), refetchInterval: SLOW });
  const { data: h } = useVaultHistory(q.data?.id, 1);
  if (!q.data || !h?.totals) return q;
  const t = h.totals;
  return {
    ...q,
    data: {
      ...q.data,
      depositedToken: t.depositedToken,
      withdrawnToken: t.withdrawnToken,
      userCount: t.userCount,
      ...(t.apy24hWad !== undefined ? { apy24hWad: t.apy24hWad } : {}),
      ...(t.apy7dWad !== undefined ? { apy7dWad: t.apy7dWad } : {}),
    },
  } as typeof q;
}

/** Share-price snapshots, newest first: the indexer's whole history when connected, else the data source's window. */
export function useVaultSnapshots(limit = 168) {
  const ds = useDataSource();
  const { data: v } = useQuery({ queryKey: ["vault", ds.kind, ds.marketKey], queryFn: () => ds.vault(), refetchInterval: SLOW });
  const h = useVaultHistory(v?.id, limit);
  const local = useQuery({
    queryKey: ["vaultSnapshots", ds.kind, ds.marketKey, limit],
    queryFn: () => ds.vaultSnapshots(limit),
    refetchInterval: 60_000,
    enabled: INDEXER_URL === undefined || h.isError,
  });
  return INDEXER_URL !== undefined && !h.isError ? { ...h, data: h.data?.snapshots } : local;
}

export function useVaultUser(account: Address) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["vaultUser", ds.kind, ds.marketKey, account], queryFn: () => ds.vaultUser(account), refetchInterval: SLOW });
}

export function useSwap(account: Address) {
  const ds = useDataSource();
  return useQuery({
    queryKey: ["swap", ds.kind, ds.marketKey, account],
    queryFn: async () => ({ stats: await ds.swapStats(), info: await ds.swapInfo(), positions: await ds.swapPositions(account) }),
    refetchInterval: 1_000, // accrual ticks per block on the Fix screen
  });
}

export function useProtocolStats() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["protocolStats", ds.kind, ds.marketKey], queryFn: () => ds.protocolStats(), refetchInterval: SLOW });
}

/** Metrics dashboard (C5): indexer only. Undefined URL ⇒ the query is off and the Stats page says so. */
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || undefined;
export function useIndexerStats() {
  return useQuery({
    queryKey: ["indexerStats", INDEXER_URL],
    queryFn: ({ signal }) => fetchIndexerStats(INDEXER_URL!, signal),
    enabled: INDEXER_URL !== undefined,
    refetchInterval: SLOW,
    retry: 1,
  });
}

/**
 * Indexer candles for the current market (the only candle source; see data/indexer/candles.ts). Off without
 * NEXT_PUBLIC_INDEXER_URL or before the market id is known: callers show "needs indexer", never mock candles.
 */
export function useIndexerCandles(table: import("./indexer/candles").CandleTable, limit: number) {
  const { data: m } = useMarket();
  const market = m?.clearingHouse;
  return useQuery({
    queryKey: ["indexerCandles", INDEXER_URL, table, market, limit],
    queryFn: async ({ signal }) => (await import("./indexer/candles")).fetchCandles(INDEXER_URL!, table, market!, limit, signal),
    enabled: INDEXER_URL !== undefined && market !== undefined,
    refetchInterval: table === "Candle1m" ? 3_000 : 30_000,
    retry: 1,
  });
}

/** Live account view (contract getAccount in chain mode). */
export function useAccountView(account: Address) {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  // chain mode reads only a connected wallet (never the mock's placeholder account against a public RPC)
  return useQuery({
    queryKey: ["accountView", ds.kind, ds.marketKey, account],
    queryFn: async () => (await ds.accountView(account)) ?? null,
    enabled: ds.kind === "mock" || isConnected,
    refetchInterval: 1_000,
  });
}

/** Market risk params (imr, mmr, fees, caps). Changes only by admin tx: slow refresh. */
export function useRiskParams() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["riskParams", ds.kind, ds.marketKey], queryFn: () => ds.riskParams(), refetchInterval: 60_000, staleTime: 30_000 });
}

/** Indexer history (trades, orders, liquidations) of the connected account; off without an indexer. */
export function useAccountHistory(account: Address, limit = 100) {
  const { isConnected } = useAccount();
  return useQuery({
    queryKey: ["accountHistory", INDEXER_URL, account, limit],
    queryFn: async ({ signal }) => (await import("./indexer/account")).fetchAccountHistory(INDEXER_URL!, account, limit, signal),
    enabled: INDEXER_URL !== undefined && isConnected,
    refetchInterval: 5_000,
    retry: 1,
  });
}

/**
 * Funding payments of the connected account, newest first. With the indexer: every FundingSettled since the
 * deployment (FundingPayment rows, `source: "indexer"`); without it, the chain source's log window (chain mode).
 */
export function useFundingSettlements(account: Address) {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  return useQuery({
    queryKey: ["fundingSettlements", ds.kind, ds.marketKey, INDEXER_URL, account],
    queryFn: async ({ signal }): Promise<{ fromBlock: bigint; items: FundingSettlement[]; source: "indexer" | "chain" }> => {
      if (INDEXER_URL !== undefined) {
        const rows = await (await import("./indexer/funding")).fetchFundingPayments(INDEXER_URL, INDEXER_CHAIN_ID, account, 500, signal);
        return { fromBlock: 0n, items: rows.map((r) => ({ block: r.block, payment: r.payment })), source: "indexer" };
      }
      return { ...(await (ds as import("./chain/source").ChainSource).fundingSettlements(account)), source: "chain" };
    },
    enabled: isConnected && (INDEXER_URL !== undefined || ds.kind === "chain"),
    refetchInterval: 5_000,
  });
}
