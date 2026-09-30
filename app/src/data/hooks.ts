"use client";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useDataSource } from "./context";
import type { Address } from "./types";
import { BLOCK_TIME_MS } from "@/lib/units";
import { MOCK } from "./mock/fixtures";

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
  return useQuery({
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
