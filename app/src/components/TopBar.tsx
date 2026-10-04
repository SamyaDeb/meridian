"use client";
import { useDataSource } from "@/data/context";
import { ConnectButton } from "./Wallet";
import { LOCAL_CHAIN_ID, READ_CHAIN_ID } from "@/lib/wagmi";
import { deploymentState } from "@/config/deployments";

const CHAIN_BADGE: Record<number, string> = { 10143: "monad testnet", 143: "monad" };

export function TopBar() {
  const ds = useDataSource();
  // NEXT_PUBLIC_CHAIN_ID=143 before A commits deployments/143.json: say so plainly; the numbers are the mock layer's
  const notDeployed = deploymentState(READ_CHAIN_ID) === "not-deployed";
  const network = CHAIN_BADGE[READ_CHAIN_ID] ?? "local chain";
  return (
    <>
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between bg-bg/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 13h5l2-6 3 11 2-7 1.5 2H22" />
        </svg>
        <span className="text-lg font-semibold tracking-tight">Pulse</span>
        {ds.kind === "chain" && <span className="rounded-full bg-long/15 px-2 py-0.5 text-[10px] font-medium uppercase text-long">{READ_CHAIN_ID === LOCAL_CHAIN_ID ? "local chain" : (CHAIN_BADGE[READ_CHAIN_ID] ?? "local chain")}</span>}
        {notDeployed && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium uppercase text-warn">{network}: not deployed yet</span>}
        {ds.kind === "mock" && !notDeployed && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium uppercase text-warn">mock data</span>}
      </div>
      {/* Login (Privy vs Mera) is pending the BOUNTY_MAP decision: injected wallet / anvil dev account for now. */}
      <ConnectButton />
    </header>
    {notDeployed && (
      <p role="status" className="mx-4 mb-1 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
        Pulse isn&apos;t live on {network} yet. Everything below is sample data, and no transactions can be sent to it.
      </p>
    )}
    </>
  );
}
