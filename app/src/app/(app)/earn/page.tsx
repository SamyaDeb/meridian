"use client";
import { useState, type ReactNode } from "react";
import { useAccount, useChainId } from "wagmi";
import { useAccountAddress, useVault, useVaultRedeems, useVaultSnapshots, useVaultUser } from "@/data/hooks";
import { Row, Sparkline } from "@/components/ui";
import { Button, Card, Chip, Dialog, Notice, PageHeader, PillTabs, Skeleton, StatCard, Tooltip } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { formatAprWad, formatAusdToken, formatAusdWad, formatBaseWad, formatDuration, formatFixed, parseFixed } from "@/lib/format";
import { vaultRoutePending, vaultStatus, vaultWithdrawFeeToken } from "@/lib/earnfix";
import { estimateRedeemToken, withdrawRoute } from "@/lib/redeem";
import { vaultCancelRedeem, vaultClaimRedeem, vaultDeposit, vaultRedeem, vaultRequestRedeem } from "@/lib/tx";
import { RedeemQueue } from "@/features/earn/RedeemQueue";
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
  const [dialog, setDialog] = useState<"deposit" | "withdraw" | null>(null);
  const [tab, setTab] = useState<"vault" | "requests" | "price" | "health">("vault");
  const vault = contractAddress(chainId, "MeridianVault");
  const q = useVaultRedeems(me, vault);
  const ausd = contractAddress(chainId, "AUSD");

  const myValueWad = v && u ? (u.shares * v.sharePriceWad) / WAD : undefined;
  const routePending = vaultRoutePending(process.env.NEXT_PUBLIC_VAULT_ROUTE_PENDING, v?.skewCapacityWad);
  const status = v ? vaultStatus(v.hedged, v.needsRebalance ?? 0, routePending) : undefined;
  // redeem preview: shares × price (token units) − the 5 bps fee (previewRedeem's rounding)
  const redeemShares = u ? (u.shares * BigInt(pct)) / 100n : 0n;
  const grossToken = v ? (redeemShares * v.sharePriceWad) / WAD / 10n ** 12n : 0n;
  const feeToken = vaultWithdrawFeeToken(grossToken);
  const netToken = v ? estimateRedeemToken(redeemShares, v.sharePriceWad) : 0n;
  // CR-014: sync redeem is idle-only (maxRedeem); beyond idle the withdrawal is a request the keeper fulfils
  const route = q.maxRedeemShares !== undefined ? withdrawRoute(redeemShares, q.maxRedeemShares, netToken, q.maxSliceToken ?? 0n) : undefined;
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
    tx.run(route?.kind === "request" ? `request withdrawal of ${pct}%` : `withdraw ${pct}%`, (p, w) => {
      if (!vault) throw new Error("no vault on this chain");
      if (redeemShares === 0n) throw new Error("nothing to withdraw");
      return route?.kind === "request" ? vaultRequestRedeem(p, w, vault, redeemShares) : vaultRedeem(p, w, vault, redeemShares);
    });
  const doCancel = (id: bigint) =>
    tx.run(`cancel request #${id}`, (p, w) => {
      if (!vault) throw new Error("no vault on this chain");
      return vaultCancelRedeem(p, w, vault, id);
    });
  const doClaim = (id: bigint) =>
    tx.run(`claim request #${id}`, (p, w) => {
      if (!vault) throw new Error("no vault on this chain");
      return vaultClaimRedeem(p, w, vault, id);
    });

  const statusChip = status && (
    <span data-testid="vault-status">
      <Chip tone={status === "hedged" ? "long" : "warn"} dot>
        {status === "hedged" ? "Hedged" : status === "rebalancing" ? "Rebalancing" : status === "waiting-route" ? "Waiting for route" : "Idle"}
      </Chip>
    </span>
  );

  const apyNode: ReactNode = !v ? (
    <Skeleton className="h-9 w-32" />
  ) : status !== "waiting" && status !== "waiting-route" && apy !== undefined ? (
    <span className="text-long">{formatAprWad(apy)}</span>
  ) : (
    "--"
  );
  const hasShares = Boolean(u && u.shares > 0n);
  const th = "pb-2 pr-4 text-left text-xs font-normal text-muted";
  const td = "py-2 pr-4 text-[13px]";

  return (
    <div className="space-y-3">
      <PageHeader
        title="Earn"
        description="Deposit AUSD into the Meridian basis vault. It holds spot MON against a short MON-PERP and earns the funding that longs pay, accrued every block, so the share price rises as funding comes in. Withdraw from idle AUSD at any time."
        actions={
          <>
            <Button variant="brand" className="min-w-28" disabled={!isConnected || !vault} onClick={() => setDialog("deposit")}>
              Deposit
            </Button>
            <Button variant="outline" className="min-w-28" disabled={!hasShares} onClick={() => setDialog("withdraw")}>
              Withdraw
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={
            <Tooltip content={apyLabel || "Measured from the vault share price; shown only once the vault is hedged and earning."}>
              <span className="dotted">Vault APY</span>
            </Tooltip>
          }
          right={statusChip}
          value={apyNode}
          sub={v?.apy7dWad !== undefined ? <span className="text-muted">7 d {formatAprWad(v.apy7dWad)}</span> : undefined}
        />
        <StatCard
          label="Your Deposit"
          value={<span data-testid="my-vault-value">{myValueWad !== undefined ? `$${formatAusdWad(myValueWad)}` : "$0.00"}</span>}
          sub={<span className="text-muted">Deposited {u ? formatAusdToken(u.depositedToken) : "0.00"} AUSD</span>}
        />
        <StatCard label="Vault TVL" value={v ? `$${formatAusdToken(v.navToken)}` : <Skeleton className="h-9 w-32" />} sub={<span className="text-muted">Funding earned {v ? formatAusdWad(v.fundingAccruedWad) : "—"} AUSD</span>} />
      </div>

      {tx.status && (
        <Notice tone={tx.status.includes("failed") ? "danger" : "info"}>
          <span className="num break-all" data-testid="tx-status">
            {tx.status}
          </span>
        </Notice>
      )}

      <Card className="p-0!" bodyClassName="px-4 pb-4 pt-3">
        <div className="border-b border-border px-4">
          <PillTabs
            ariaLabel="Earn view"
            panelIdPrefix="earn"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "vault", label: "Basis Vault" },
              { id: "requests", label: "Withdrawal Requests", count: q.pendingIds?.length },
              { id: "price", label: "Share Price" },
              { id: "health", label: "Vault Health" },
            ]}
          />
        </div>
        <div className="pt-1">
          {tab === "vault" && (
            <div id="earn-vault" role="tabpanel" className="space-y-3">
              <h2 className="pt-1 text-[15px]">Vault</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px]">
                  <thead>
                    <tr>
                      <th className={th}>Asset</th>
                      <th className={th}>Strategy</th>
                      <th className={th}>APY</th>
                      <th className={th}>
                        <Tooltip content="AUSD value of one vault share; it rises as funding accrues.">
                          <span className="dotted">Share Price</span>
                        </Tooltip>
                      </th>
                      <th className={th}>Your Deposit</th>
                      <th className={th}>Funding Earned</th>
                      <th className={th}>Total Value Locked</th>
                      <th className={th}>Action</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    <tr>
                      <td className={`${td} font-medium text-brand-soft`}>AUSD</td>
                      <td className={td}>Spot MON + short MON-PERP</td>
                      <td className={`${td} text-long`}>{apy !== undefined && status !== "waiting" && status !== "waiting-route" ? formatAprWad(apy) : "N/A"}</td>
                      <td className={td}>{v ? <span data-testid="share-price">{formatFixed(v.sharePriceWad, 18, 12)}</span> : "—"}</td>
                      <td className={td}>{myValueWad !== undefined ? `${formatAusdWad(myValueWad)} AUSD` : "0.00 AUSD"}</td>
                      <td className={td}>{v ? `${formatAusdWad(v.fundingAccruedWad)} AUSD` : "—"}</td>
                      <td className={td}>{v ? `${formatAusdToken(v.navToken)} AUSD` : "—"}</td>
                      <td className={`${td} space-x-4 whitespace-nowrap`}>
                        <button type="button" className="text-brand-soft hover:underline disabled:text-brand-soft/35 disabled:no-underline" disabled={!isConnected || !vault} onClick={() => setDialog("deposit")}>
                          Deposit
                        </button>
                        <button type="button" className="text-brand-soft hover:underline disabled:text-brand-soft/35 disabled:no-underline" disabled={!hasShares} onClick={() => setDialog("withdraw")}>
                          Withdraw
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {!v ? null : status === "waiting-route" ? (
                <Notice tone="warn" title="Waiting for the spot route">
                  <span data-testid="waiting-for-route">Deposits stay idle AUSD (no hedge, no yield yet) and can be withdrawn from idle.</span>
                </Notice>
              ) : status === "waiting" ? (
                // Never show a fake APY (lane brief §3); PRD US6.
                <Notice tone="warn" title="Waiting for funding">
                  <span data-testid="waiting-for-funding">The vault hedges only when the 8 h funding rate pays for the round trip (≈ 15.6% APR).</span>
                </Notice>
              ) : apy === undefined ? (
                // hedged (or rebalancing) but no share-price window yet in the lookback: earning, APY not measurable yet
                <p className="text-sm text-long" data-testid="earning-no-apy">
                  Earning funding every block. The APY shows once the share-price history covers a window.
                </p>
              ) : null}
            </div>
          )}
          {tab === "requests" && (
            <div id="earn-requests" role="tabpanel" className="pt-2 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0">
              <RedeemQueue
                rows={q.rows}
                pendingIds={q.pendingIds}
                queueComplete={q.queueComplete}
                sharePriceWad={v?.sharePriceWad}
                me={isConnected ? me : undefined}
                loading={q.isLoading}
                busy={tx.busy}
                block={q.block}
                onCancel={doCancel}
                onClaim={doClaim}
              />
            </div>
          )}
          {tab === "price" && (
            <div id="earn-price" role="tabpanel" className="pt-2">
              <div className="mb-2 text-xs text-muted">Share price{snaps && snaps.length > 1 ? `, last ${snaps.length} snapshots` : ""}</div>
              {snaps && snaps.length > 1 ? (
                <Sparkline className="h-64 w-full" stroke="var(--brand-soft)" values={snaps.slice().reverse().map((x) => Number(x.sharePriceWad / 10n ** 6n) / 1e12)} />
              ) : (
                <p className="py-16 text-center text-sm text-muted">Not enough share-price history yet.</p>
              )}
            </div>
          )}
          {tab === "health" && (
            <div id="earn-health" role="tabpanel" className="pt-2">
              <div className="grid gap-x-12 md:grid-cols-2">
                <Row label="TVL" value={v ? `${formatAusdToken(v.navToken)} AUSD` : "—"} />
                <Row label="Share price" value={v ? formatFixed(v.sharePriceWad, 18, 12) : "—"} />
                {v?.spotBaseWad !== undefined && <Row label="Spot MON / perp short" value={`${formatBaseWad(v.spotBaseWad, 0)} / ${formatBaseWad(-(v.perpSizeWad ?? 0n), 0)}`} />}
                {v?.shortCapacityWad !== undefined && <Row label="Short capacity (skew)" value={`${formatBaseWad(v.shortCapacityWad, 0)} MON`} />}
                {v?.idleToken !== undefined && <Row label="Idle AUSD" value={formatAusdToken(v.idleToken)} />}
                <Row label="Funding earned" value={v ? `${formatAusdWad(v.fundingAccruedWad)} AUSD` : "—"} />
              </div>
              <p className="mt-3 text-xs text-muted">The vault holds spot MON and a short MON-PERP, and only takes the short when other traders are net long (it never creates short skew).</p>
            </div>
          )}
        </div>
      </Card>

      <Dialog open={dialog === "deposit"} onClose={() => setDialog(null)} title="Deposit AUSD">
        <label htmlFor="vault-amt" className="text-xs text-muted">
          Amount (AUSD)
        </label>
        <input
          id="vault-amt"
          data-autofocus
          aria-label="Vault deposit amount"
          inputMode="decimal"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          className="num mt-1 h-11 w-full rounded-control border border-line bg-card-2 px-3 text-sm outline-none focus:border-brand-soft"
        />
        <p className="mt-2 text-xs text-muted">Deposits stay idle until the next rebalance.</p>
        <Button variant="brand" size="lg" block className="mt-4" disabled={!isConnected || !vault || tx.busy} loading={tx.busy} onClick={doDeposit}>
          Deposit AUSD
        </Button>
      </Dialog>

      <Dialog open={dialog === "withdraw"} onClose={() => setDialog(null)} title="Withdraw">
        <label htmlFor="wpct" className="text-xs text-muted">
          Withdraw {pct}%
        </label>
        <input id="wpct" type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="mt-1 h-11 w-full" />
        <Row label={route?.kind === "request" ? "Estimate now ≈" : "You receive ≈"} value={`${formatAusdToken(netToken)} AUSD`} />
        <Row label="Withdrawal fee (5 bps, stays in the vault)" value={`${formatAusdToken(feeToken)} AUSD`} />
        <Row
          label="Path"
          value={
            <span data-testid="withdraw-path">
              {route?.kind === "redeem"
                ? "from idle AUSD now (no trade)"
                : route?.kind === "request"
                  ? routePending
                    ? "beyond idle AUSD: a request. It waits until the spot route is live; you can cancel it while it waits"
                    : "beyond idle AUSD: a request. The keeper prices it at the share price when it fulfils it; you pay that unwind's cost"
                  : route?.kind === "split"
                    ? `above one request's cap: request at most ${formatFixed(route.maxShares, 18, 2)} shares at a time`
                    : "—"}
            </span>
          }
          tone={route?.kind === "request" || route?.kind === "split" ? "warn" : undefined}
        />
        <Button
          variant="brand"
          size="lg"
          block
          className="mt-4"
          data-testid="withdraw"
          disabled={!isConnected || tx.busy || route === undefined || route.kind === "none" || route.kind === "split"}
          loading={tx.busy}
          onClick={doRedeem}
        >
          {route?.kind === "request" ? "Request withdrawal" : "Withdraw"}
        </Button>
      </Dialog>
    </div>
  );
}
