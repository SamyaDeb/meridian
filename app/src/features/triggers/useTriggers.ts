"use client";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { contractAddress } from "@/config/deployments";
import { chainTriggerClient, mockTriggerClient, triggerMode, type TriggerClient } from "./client";

const mock = mockTriggerClient(); // one per tab, so the mocked list survives re-renders

/** The trigger client for this chain, or undefined when the feature is off (no manager deployed, no mock flag). */
export function useTriggerClient(): TriggerClient | undefined {
  const chainId = useChainId();
  const pub = usePublicClient();
  const mode = triggerMode(chainId);
  if (mode === "off") return undefined;
  if (mode === "mock") return mock;
  const m = contractAddress(chainId, "TriggerOrderManager");
  const ausd = contractAddress(chainId, "AUSD");
  return pub && m && ausd ? chainTriggerClient(pub as PublicClient, m, ausd) : undefined;
}

export function useTriggers() {
  const client = useTriggerClient();
  const { address } = useAccount();
  const q = useQuery({
    queryKey: ["triggers", client?.mode, address],
    queryFn: () => client!.list(address!),
    enabled: Boolean(client && address),
    refetchInterval: 3_000,
  });
  const tip = useQuery({ queryKey: ["triggerTip", client?.mode], queryFn: () => client!.tip(), enabled: Boolean(client), staleTime: 60_000 });
  return { client, triggers: q.data, tip: tip.data, refetch: q.refetch };
}
