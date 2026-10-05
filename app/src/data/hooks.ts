"use client";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useDataSource } from "./context";
import type { Address } from "./types";
import { BLOCK_TIME_MS } from "@/lib/units";
import { MOCK } from "./mock/fixtures";
import { fetchIndexerStats } from "./indexer/stats";

// Per-block data refreshes every block (300 ms); the rest every few seconds.
// WS-07 task 2: on testnet/mainnet useFundingTicker switches to a WSS newHeads subscription + previewFundingState().
const PER_BLOCK = BLOCK_TIME_MS;
const SLOW = 5_000;

export function useMarket() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["market", ds.kind], queryFn: () => ds.market(), refetchInterval: PER_BLOCK });
}

export function useFundingTicks(limit = 300) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["fundingTicks", ds.kind, limit], queryFn: () => ds.fundingTicks(limit), refetchInterval: PER_BLOCK });
}

export function useDepth(levels = 6) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["depth", ds.kind, levels], queryFn: () => ds.depth(levels), refetchInterval: 1_000 });
}

export function useTrades(limit = 12) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["trades", ds.kind, limit], queryFn: () => ds.trades(limit), refetchInterval: 1_000 });
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
    queryKey: ["openOrders", ds.kind, account],
    queryFn: () => ("openOrders" in ds ? (ds as import("./chain/source").ChainSource).openOrders(account) : Promise.resolve([])),
    refetchInterval: 1_000,
  });
}

export function usePositions(account: Address) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["positions", ds.kind, account], queryFn: () => ds.positions(account), refetchInterval: SLOW });
}

export function useVault() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["vault", ds.kind], queryFn: () => ds.vault(), refetchInterval: SLOW });
}

export function useVaultSnapshots(limit = 168) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["vaultSnapshots", ds.kind, limit], queryFn: () => ds.vaultSnapshots(limit), refetchInterval: 60_000 });
}

export function useVaultUser(account: Address) {
  const ds = useDataSource();
  return useQuery({ queryKey: ["vaultUser", ds.kind, account], queryFn: () => ds.vaultUser(account), refetchInterval: SLOW });
}

export function useSwap(account: Address) {
  const ds = useDataSource();
  return useQuery({
    queryKey: ["swap", ds.kind, account],
    queryFn: async () => ({ stats: await ds.swapStats(), info: await ds.swapInfo(), positions: await ds.swapPositions(account) }),
    refetchInterval: 1_000, // accrual ticks per block on the Fix screen
  });
}

export function useProtocolStats() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["protocolStats", ds.kind], queryFn: () => ds.protocolStats(), refetchInterval: SLOW });
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
    queryKey: ["accountView", ds.kind, account],
    queryFn: async () => (await ds.accountView(account)) ?? null,
    enabled: ds.kind === "mock" || isConnected,
    refetchInterval: 1_000,
  });
}

/** Market risk params (imr, mmr, fees, caps). Changes only by admin tx: slow refresh. */
export function useRiskParams() {
  const ds = useDataSource();
  return useQuery({ queryKey: ["riskParams", ds.kind], queryFn: () => ds.riskParams(), refetchInterval: 60_000, staleTime: 30_000 });
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

/** Per-block funding payments over the chain log window (chain mode, connected wallet). */
export function useFundingSettlements(account: Address) {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  return useQuery({
    queryKey: ["fundingSettlements", ds.kind, account],
    queryFn: () => (ds as import("./chain/source").ChainSource).fundingSettlements(account),
    enabled: ds.kind === "chain" && isConnected,
    refetchInterval: 5_000,
  });
}
