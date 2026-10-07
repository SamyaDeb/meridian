"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { Button, Dialog, Notice } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { clearingHouseAbi, erc20Abi } from "@/lib/abi";
import { deposit, sendTx } from "@/lib/tx";
import { formatAusdToken, parseFixed } from "@/lib/format";
import { wadToToken } from "@/lib/math";
import { AUSD_DECIMALS } from "@/lib/units";

/**
 * Deposit / withdraw AUSD (6 dp at the boundary, CONTRIBUTING.md §2). Withdraw max = free collateral converted WAD → token
 * rounding down (the user receives less, never more than the contract allows).
 */
export function FundsDialog({ mode, open, onClose, freeCollateralWad }: { mode: "deposit" | "withdraw"; open: boolean; onClose: () => void; freeCollateralWad: bigint | undefined }) {
  const chainId = useChainId();
  const pub = usePublicClient();
  const { address } = useAccount();
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const ch = contractAddress(chainId, "ClearingHouse");
  const ausd = contractAddress(chainId, "AUSD");
  const { data: walletBal } = useQuery({
    queryKey: ["ausdBalance", chainId, address, ausd],
    queryFn: () => pub!.readContract({ address: ausd!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
    enabled: open && mode === "deposit" && Boolean(pub && address && ausd),
    refetchInterval: 5_000,
  });
  const maxToken = mode === "deposit" ? walletBal : freeCollateralWad !== undefined ? wadToToken(freeCollateralWad) : undefined;
  const token = parseFixed(amount, AUSD_DECIMALS);
  const tooMuch = token !== undefined && maxToken !== undefined && token > maxToken;
  const invalid = token === undefined || token === 0n || tooMuch;
  const submit = () =>
    tx.run(`${mode} ${amount} AUSD`, (p, w) => {
      if (!ch || !ausd) throw new Error("no AUSD/ClearingHouse for this chain");
      if (token === undefined) throw new Error("invalid amount");
      return mode === "deposit" ? deposit(p, w, ausd, ch, token) : sendTx(p, w, { address: ch, abi: clearingHouseAbi, functionName: "withdraw", args: [token] });
    });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "deposit" ? "Deposit AUSD" : "Withdraw AUSD"}
      footer={
        <Button variant="brand" block size="lg" disabled={invalid || tx.busy || !address} loading={tx.busy} onClick={submit}>
          {mode === "deposit" ? "Deposit AUSD" : "Withdraw AUSD"}
        </Button>
      }
    >
      <label className="block text-xs text-muted" htmlFor={`funds-${mode}`}>
        Amount (AUSD)
        <span className="num float-right">
          {mode === "deposit" ? "Wallet" : "Free"} {maxToken !== undefined ? formatAusdToken(maxToken) : "—"}
        </span>
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`funds-${mode}`}
          data-autofocus
          aria-label={mode === "deposit" ? "Deposit amount" : "Withdraw amount"}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="num h-11 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm"
        />
        <Button size="md" disabled={maxToken === undefined} onClick={() => maxToken !== undefined && setAmount(formatAusdToken(maxToken).replace(/,/g, ""))}>
          Max
        </Button>
      </div>
      {tooMuch && <p className="mt-2 text-xs text-short">More than {mode === "deposit" ? "your wallet holds" : "your free collateral"}.</p>}
      {mode === "deposit" && <p className="mt-2 text-[11px] text-muted">One signature (permit) where AUSD supports it, otherwise approve + deposit.</p>}
      {mode === "withdraw" && <p className="mt-2 text-[11px] text-muted">Free collateral = equity − margin used by your position and open orders.</p>}
      {tx.status && (
        <Notice tone={tx.status.includes("failed") ? "danger" : "info"} className="mt-3">
          <span className="num break-all" data-testid="tx-status">
            {tx.status}
          </span>
        </Notice>
      )}
    </Dialog>
  );
}
