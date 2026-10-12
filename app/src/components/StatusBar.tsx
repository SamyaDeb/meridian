"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useDataSource } from "@/data/context";
import { Tooltip } from "@/components/ds";
import { readChain } from "@/lib/wagmi";

const REPO = "https://github.com/SamyaDeb/meridian";

/** Connection state from one eth_blockNumber round-trip every 10 s (chain mode); mock data says so instead. */
function useOnline(): { state: "online" | "slow" | "offline" | "mock" | "checking"; detail: string } {
  const ds = useDataSource();
  const pub = usePublicClient({ chainId: readChain().chain.id });
  const { data, isError } = useQuery({
    queryKey: ["statusBarRtt", readChain().chain.id],
    enabled: ds.kind === "chain" && Boolean(pub),
    refetchInterval: 10_000,
    queryFn: async () => {
      const t0 = performance.now();
      await pub!.getBlockNumber({ cacheTime: 0 });
      return Math.round(performance.now() - t0);
    },
  });
  if (ds.kind !== "chain") return { state: "mock", detail: "Sample data: no RPC connection is used." };
  if (isError) return { state: "offline", detail: "The RPC is not answering; numbers on screen may be out of date." };
  if (data === undefined) return { state: "checking", detail: "Checking the RPC connection…" };
  return data > 1_000 ? { state: "slow", detail: `RPC round-trip ${data} ms` } : { state: "online", detail: `RPC round-trip ${data} ms` };
}

const LABEL = { online: "Online", slow: "Slow", offline: "Offline", mock: "Sample data", checking: "Connecting" } as const;
const TONE = {
  online: "border-long/50 text-long",
  slow: "border-warn/50 text-warn",
  offline: "border-short/50 text-short",
  mock: "border-warn/50 text-warn",
  checking: "border-line text-muted",
} as const;

/** Desktop status bar pinned to the bottom (Hyperliquid style): connection pill left, links right. */
export function StatusBar() {
  const { state, detail } = useOnline();
  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 hidden h-8 items-center justify-between border-t border-border bg-card/95 px-3 backdrop-blur lg:flex">
      <Tooltip content={detail}>
        <span data-testid="status-pill" className={`inline-flex h-6 items-center gap-1.5 rounded-control border px-2 text-[11px] ${TONE[state]}`}>
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${state === "online" ? "animate-pulse" : ""}`} aria-hidden />
          {LABEL[state]}
        </span>
      </Tooltip>
      <nav aria-label="Footer" className="flex items-center gap-5 text-xs text-text">
        <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-brand-soft">
          Docs
        </a>
        <Link href="/rates" className="hover:text-brand-soft">
          Rates &amp; risk
        </Link>
        <Link href="/terms" className="hover:text-brand-soft">
          Terms
        </Link>
      </nav>
    </footer>
  );
}
