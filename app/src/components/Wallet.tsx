"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, usePublicClient, useWalletClient } from "wagmi";
import type { PublicClient, WalletClient } from "viem";
import { useWriteGate } from "./WriteGate";

/** Connect: injected wallet (login decision pending) or, on anvil, the dev account connector. */
export function ConnectButton() {
  const { isConnected, address } = useAccount();
  const { connectors, connect } = useConnect();
  if (isConnected) return <span className="num text-[11px] text-muted">{`${address?.slice(0, 6)}…${address?.slice(-4)}`}</span>;
  return (
    <div className="flex gap-2">
      {connectors.map((c) => (
        <button key={c.uid} type="button" onClick={() => connect({ connector: c })} className="h-11 rounded-lg bg-surface-2 px-3 text-xs">
          {c.type === "mock" ? "Dev account" : "Connect wallet"}
        </button>
      ))}
    </div>
  );
}

/** Runs one write at a time with a status line; refreshes every query after success. Every write passes the gate first
 *  (terms accepted for this version, viewer not geo-restricted: C3). */
export function useTx() {
  const pub = usePublicClient();
  const { data: wallet } = useWalletClient();
  const qc = useQueryClient();
  const gate = useWriteGate();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  async function run(label: string, fn: (p: PublicClient, w: WalletClient) => Promise<{ block: bigint; gasUsed: bigint; gasLimit: bigint }>) {
    if (!pub || !wallet) return setStatus("Connect first");
    if (!(await gate.ensure())) return setStatus(`${label} cancelled`);
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const r = await fn(pub as PublicClient, wallet as WalletClient);
      setStatus(`${label} ✓ block ${r.block} · gas ${r.gasUsed}/${r.gasLimit}`);
      await qc.invalidateQueries();
    } catch (e) {
      setStatus(`${label} failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    } finally {
      setBusy(false);
    }
  }
  return { run, status, busy, ready: Boolean(pub && wallet) };
}
