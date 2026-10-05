"use client";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useDataSource } from "@/data/context";
import { Chip, Tooltip } from "@/components/ds";
import { readChain } from "@/lib/wagmi";

/** RPC round-trip (one eth_blockNumber every 10 s, chain mode only) and the measured block time between two reads. */
export function StatusChip() {
  const ds = useDataSource();
  const pub = usePublicClient({ chainId: readChain().chain.id });
  const { data, isError } = useQuery({
    queryKey: ["rpcStatus", readChain().chain.id],
    enabled: ds.kind === "chain" && Boolean(pub),
    refetchInterval: 10_000,
    queryFn: async () => {
      const t0 = performance.now();
      const b1 = await pub!.getBlockNumber({ cacheTime: 0 });
      const t1 = performance.now();
      await new Promise((r) => setTimeout(r, 1_500));
      const b2 = await pub!.getBlockNumber({ cacheTime: 0 });
      const t2 = performance.now();
      return { rttMs: Math.round(t1 - t0), blockMs: b2 > b1 ? Math.round((t2 - t1) / Number(b2 - b1)) : undefined };
    },
  });
  if (ds.kind !== "chain") return null;
  const slow = isError || (data?.rttMs ?? 0) > 1_000;
  return (
    <Tooltip content="RPC round-trip and the block time measured between two reads (nominal ~300 ms)." side="bottom">
      <span data-testid="status-chip">
        <Chip tone={slow ? "warn" : "neutral"} className="num">
          {isError ? "RPC error" : data ? `RPC ${data.rttMs} ms${data.blockMs !== undefined ? ` · ${data.blockMs} ms/block` : ""}` : "RPC …"}
        </Chip>
      </span>
    </Tooltip>
  );
}
