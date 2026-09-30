"use client";
import { useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { useAccountAddress, useVault, useVaultSnapshots, useVaultUser } from "@/data/hooks";
import { Card, Row, Skeleton, Sparkline } from "@/components/ui";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { formatAprWad, formatAusdToken, formatAusdWad, formatBaseWad, formatDuration, formatFixed, parseFixed } from "@/lib/format";
import { vaultStatus, vaultWithdrawFeeToken, vaultWithdrawPath } from "@/lib/earnfix";
import { vaultDeposit, vaultRedeem } from "@/lib/tx";
import { WAD } from "@/lib/units";

export default function EarnPage() {
  const me = useAccountAddress();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { data: v } = useVault();
  const { data: snaps } = useVaultSnapshots(168);
  const { data: u } = useVaultUser(me);
  const tx = useTx();
  const [amt, setAmt] = useState("100");
  const [pct, setPct] = useState(100);
  const vault = contractAddress(chainId, "PulseVault");
  const ausd = contractAddress(chainId, "AUSD");

  const myValueWad = v && u ? (u.shares * v.sharePriceWad) / WAD : undefined;
  const status = v ? vaultStatus(v.hedged, v.needsRebalance ?? 0) : undefined;
  // redeem preview: shares × price (token units) − the 5 bps fee; the path decides whether an unwind cost applies
  const redeemShares = u ? (u.shares * BigInt(pct)) / 100n : 0n;
  const grossToken = v ? (redeemShares * v.sharePriceWad) / WAD / 10n ** 12n : 0n;
  const feeToken = vaultWithdrawFeeToken(grossToken);
  const path = v?.idleToken !== undefined ? vaultWithdrawPath(v.idleToken, grossToken - feeToken) : undefined;
  const apy = v?.apy24hWad ?? v?.apyWad;
  const apyLabel =
    v?.apy24hWad !== undefined ? "APY, last 24 h" : v?.apyWindowSec !== undefined ? `APY from the share price, last ${formatDuration(v.apyWindowSec)}` : "";

  const doDeposit = () =>
    tx.run(`deposit ${amt} AUSD`, (p, w) => {
      const a = parseFixed(amt, 6);
      if (!vault || !ausd) throw new Error("no vault on this chain");
      if (a === undefined || a === 0n) throw new Error("enter an amount");
      return vaultDeposit(p, w, ausd, vault, a);
    });
  const doRedeem = () =>
    tx.run(`withdraw ${pct}%`, (p, w) => {
      if (!vault) throw new Error("no vault on this chain");
      if (redeemShares === 0n) throw new Error("nothing to withdraw");
      return vaultRedeem(p, w, vault, redeemShares);
    });

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Earn the basis</h1>
      <Card
        title="Pulse basis vault · AUSD"
        right={
          status && (
            <span data-testid="vault-status" className={`text-xs ${status === "hedged" ? "text-long" : "text-warn"}`}>
              {status === "hedged" ? "● Hedged" : status === "rebalancing" ? "● Rebalancing" : "● Idle"}
            </span>
          )
        }
      >
        {!v ? (
          <Skeleton className="h-16 w-full" />
        ) : status !== "waiting" && apy !== undefined ? (
          <div>
            <div className="num text-3xl font-semibold text-long">{formatAprWad(apy)}</div>
            <div className="text-xs text-muted">
              {apyLabel}
              {v.apy7dWad !== undefined && ` · 7 d ${formatAprWad(v.apy7dWad)}`}
            </div>
          </div>
        ) : (
          // Never show a fake APY (lane brief §3); PRD US6.
          <p className="text-sm text-warn" data-testid="waiting-for-funding">
            Waiting for funding. The vault hedges only when the 8 h funding rate pays for the round trip (≈ 15.6% APR).
          </p>
        )}
        <Sparkline className="mt-3 h-16 w-full" values={(snaps ?? []).slice().reverse().map((s) => Number(s.sharePriceWad) / 1e18)} />
        <div className="mt-2 border-t border-border pt-2">
          <Row label="TVL" value={v ? `${formatAusdToken(v.navToken)} AUSD` : "—"} />
          <Row label="Share price" value={v ? <span data-testid="share-price">{formatFixed(v.sharePriceWad, 18, 12)}</span> : "—"} />
          {v?.spotBaseWad !== undefined && (
            <Row label="Spot MON / perp short" value={`${formatBaseWad(v.spotBaseWad, 0)} / ${formatBaseWad(-(v.perpSizeWad ?? 0n), 0)}`} />
          )}
          {v?.shortCapacityWad !== undefined && <Row label="Short capacity (skew)" value={`${formatBaseWad(v.shortCapacityWad, 0)} MON`} />}
          {v?.idleToken !== undefined && <Row label="Idle AUSD" value={formatAusdToken(v.idleToken)} />}
          <Row label="Funding earned" value={v ? `${formatAusdWad(v.fundingAccruedWad)} AUSD` : "—"} />
        </div>
      </Card>

      <Card title="Your deposit">
        <div className="num text-2xl font-semibold" data-testid="my-vault-value">
          {myValueWad !== undefined ? `${formatAusdWad(myValueWad)} AUSD` : "—"}
        </div>
        <div className="text-xs text-muted">Deposited {u ? formatAusdToken(u.depositedToken) : "—"} AUSD</div>
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Vault deposit amount"
            inputMode="decimal"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            className="num h-12 min-w-0 flex-1 rounded-xl bg-surface-2 px-3 text-sm"
          />
          <button
            type="button"
            disabled={!isConnected || !vault || tx.busy}
            onClick={doDeposit}
            className="h-12 min-w-28 rounded-xl bg-accent px-4 font-semibold text-bg disabled:opacity-60"
          >
            {isConnected ? "Deposit" : "Log in"}
          </button>
        </div>
        {u && u.shares > 0n && (
          <div className="mt-3 border-t border-border pt-3">
            <label htmlFor="wpct" className="text-xs text-muted">
              Withdraw {pct}%
            </label>
            <input id="wpct" type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="mt-1 h-11 w-full" />
            <Row label="You receive ≈" value={`${formatAusdToken(grossToken - feeToken)} AUSD`} />
            <Row label="Withdrawal fee (5 bps, stays in the vault)" value={`${formatAusdToken(feeToken)} AUSD`} />
            <Row
              label="Path"
              value={path === "unwind" ? "unwind: a slice of both legs is sold; you pay its cost" : path === "idle" ? "from idle AUSD (no trade)" : "—"}
              tone={path === "unwind" ? "warn" : undefined}
            />
            <button type="button" disabled={!isConnected || tx.busy} onClick={doRedeem} className="mt-2 h-12 w-full rounded-xl bg-surface-2 font-semibold disabled:opacity-60">
              Withdraw
            </button>
          </div>
        )}
        {tx.status && (
          <p className="num mt-2 break-all text-[11px] text-muted" data-testid="tx-status">
            {tx.status}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Deposits stay idle until the next rebalance. The vault holds spot MON and a short MON-PERP, and only takes the short when other traders are net long.
        </p>
      </Card>
    </div>
  );
}
