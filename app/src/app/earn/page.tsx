"use client";
import { useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { useAccountAddress, useVault, useVaultSnapshots, useVaultUser } from "@/data/hooks";
import { Row, Sparkline } from "@/components/ui";
import { Button, Card, Chip, Notice, Skeleton } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { formatAprWad, formatAusdToken, formatAusdWad, formatBaseWad, formatDuration, formatFixed, parseFixed } from "@/lib/format";
import { vaultRoutePending, vaultStatus, vaultWithdrawFeeToken, vaultWithdrawPath } from "@/lib/earnfix";
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
  const vault = contractAddress(chainId, "MeridianVault");
  const ausd = contractAddress(chainId, "AUSD");

  const myValueWad = v && u ? (u.shares * v.sharePriceWad) / WAD : undefined;
  const routePending = vaultRoutePending(process.env.NEXT_PUBLIC_VAULT_ROUTE_PENDING, v?.skewCapacityWad);
  const status = v ? vaultStatus(v.hedged, v.needsRebalance ?? 0, routePending) : undefined;
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

  const statusChip = status && (
    <span data-testid="vault-status">
      <Chip tone={status === "hedged" ? "long" : "warn"} dot>
        {status === "hedged" ? "Hedged" : status === "rebalancing" ? "Rebalancing" : status === "waiting-route" ? "Waiting for route" : "Idle"}
      </Chip>
    </span>
  );

  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <h1 className="text-xl font-semibold">Earn the basis</h1>
        <p className="text-xs text-muted">Meridian basis vault · AUSD. Floating yield from per-block funding, delta-neutral.</p>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-2">
          <Card title="Vault yield" right={statusChip}>
            {!v ? (
              <Skeleton className="h-[52px] w-full" />
            ) : status === "waiting-route" ? (
              <Notice tone="warn" title="Waiting for the spot route">
                <span data-testid="waiting-for-route">Deposits stay idle AUSD (no hedge, no yield yet) and can be withdrawn from idle.</span>
              </Notice>
            ) : status !== "waiting" && apy !== undefined ? (
              <div>
                <div className="num text-3xl font-semibold text-long">{formatAprWad(apy)}</div>
                <div className="text-xs text-muted">
                  {apyLabel}
                  {v.apy7dWad !== undefined && ` · 7 d ${formatAprWad(v.apy7dWad)}`}
                </div>
              </div>
            ) : status !== "waiting" ? (
              // hedged (or rebalancing) but no share-price window yet in the lookback: earning, APY not measurable yet
              <p className="text-sm text-long" data-testid="earning-no-apy">
                Earning funding every block. The APY shows once the share-price history covers a window.
              </p>
            ) : (
              // Never show a fake APY (lane brief §3); PRD US6.
              <Notice tone="warn" title="Waiting for funding">
                <span data-testid="waiting-for-funding">The vault hedges only when the 8 h funding rate pays for the round trip (≈ 15.6% APR).</span>
              </Notice>
            )}
            <div className="mt-3 rounded-inner bg-card-2 p-2">
              <div className="mb-1 text-[11px] text-muted">Share price{snaps && snaps.length > 1 ? `, last ${snaps.length} snapshots` : ""}</div>
              {snaps && snaps.length > 1 ? (
                <Sparkline className="h-20 w-full lg:h-32" values={snaps.slice().reverse().map((x) => Number(x.sharePriceWad / 10n ** 6n) / 1e12)} />
              ) : (
                <p className="py-4 text-center text-[11px] text-muted">Not enough share-price history yet.</p>
              )}
            </div>
          </Card>
          <Card title="Vault health">
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Row label="TVL" value={v ? `${formatAusdToken(v.navToken)} AUSD` : "—"} />
              <Row label="Share price" value={v ? <span data-testid="share-price">{formatFixed(v.sharePriceWad, 18, 12)}</span> : "—"} />
              {v?.spotBaseWad !== undefined && <Row label="Spot MON / perp short" value={`${formatBaseWad(v.spotBaseWad, 0)} / ${formatBaseWad(-(v.perpSizeWad ?? 0n), 0)}`} />}
              {v?.shortCapacityWad !== undefined && <Row label="Short capacity (skew)" value={`${formatBaseWad(v.shortCapacityWad, 0)} MON`} />}
              {v?.idleToken !== undefined && <Row label="Idle AUSD" value={formatAusdToken(v.idleToken)} />}
              <Row label="Funding earned" value={v ? `${formatAusdWad(v.fundingAccruedWad)} AUSD` : "—"} />
            </div>
            <p className="mt-2 text-[11px] text-muted">The vault holds spot MON and a short MON-PERP, and only takes the short when other traders are net long (it never creates short skew).</p>
          </Card>
        </div>

        <Card title="Your deposit" className="h-fit">
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
              className="num h-12 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm"
            />
            <Button variant="brand" size="lg" className="min-w-28" disabled={!isConnected || !vault || tx.busy} loading={tx.busy} onClick={doDeposit}>
              {isConnected ? "Deposit" : "Log in"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">Deposits stay idle until the next rebalance.</p>
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
                value={
                  path === "unwind"
                    ? routePending
                      ? "needs an unwind: not available until the spot route is live; withdraw less"
                      : "unwind: a slice of both legs is sold; you pay its cost"
                    : path === "idle"
                      ? "from idle AUSD (no trade)"
                      : "—"
                }
                tone={path === "unwind" ? "warn" : undefined}
              />
              <Button size="lg" block className="mt-2" disabled={!isConnected || tx.busy || (routePending && path === "unwind")} onClick={doRedeem}>
                Withdraw
              </Button>
            </div>
          )}
          {tx.status && (
            <Notice tone={tx.status.includes("failed") ? "danger" : "info"} className="mt-2">
              <span className="num break-all" data-testid="tx-status">
                {tx.status}
              </span>
            </Notice>
          )}
        </Card>
      </div>
    </div>
  );
}
