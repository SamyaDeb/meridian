"use client";
import { useDataSource } from "@/data/context";
import { LOCAL_CHAIN_ID, READ_CHAIN_ID } from "@/lib/wagmi";
import { deploymentState } from "@/config/deployments";
import { Chip } from "@/components/ds";

export const CHAIN_BADGE: Record<number, string> = { 10143: "monad testnet", 143: "monad" };
export const networkName = (): string => CHAIN_BADGE[READ_CHAIN_ID] ?? "local chain";
export const isNotDeployed = (): boolean => deploymentState(READ_CHAIN_ID) === "not-deployed";

/** Which network the numbers come from; "not deployed yet" and "mock data" states are never hidden. */
export function NetworkChip() {
  const ds = useDataSource();
  if (isNotDeployed()) return <Chip tone="warn">{networkName()}: not deployed yet</Chip>;
  if (ds.kind === "mock") return <Chip tone="warn">mock data</Chip>;
  return <Chip tone="brand">{READ_CHAIN_ID === LOCAL_CHAIN_ID ? "local chain" : networkName()}</Chip>;
}
