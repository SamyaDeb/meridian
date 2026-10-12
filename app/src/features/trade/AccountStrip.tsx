"use client";
import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { useAccountAddress, useAccountView } from "@/data/hooks";
import { useDataSource } from "@/data/context";
import { Button, Card, NumberCell, Tooltip } from "@/components/ds";
import { Private } from "@/components/Private";
import { freeCollateralWad, health, marginRatioWad } from "@/lib/account";
import { formatAusdWad, formatFixed } from "@/lib/format";
import { WAD } from "@/lib/units";
import { setDraft } from "./draft";

const TXT = { safe: "text-long", warn: "text-warn", danger: "text-short" } as const;
const STROKE = { safe: "var(--long)", warn: "var(--warn)", danger: "var(--short)" } as const;

function Line({ label, tip, children, testId }: { label: string; tip?: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-[13px]">
      {tip ? (
        <Tooltip content={tip}>
          <span className="dotted text-muted">{label}</span>
        </Tooltip>
      ) : (
        <span className="text-muted">{label}</span>
      )}
      <span className="num" data-testid={testId}>
        {children}
      </span>
    </div>
  );
}

/** Half-circle gauge for the margin ratio (Hyperliquid's account-ratio dial). */
function Gauge({ pct, h }: { pct: number; h: keyof typeof STROKE }) {
  const r = 7;
  const len = Math.PI * r;
  return (
    <svg viewBox="0 0 18 10" className="h-3 w-[22px]" aria-hidden>
      <path d="M2 9a7 7 0 0 1 14 0" fill="none" stroke="var(--border)" strokeWidth={2.4} strokeLinecap="round" />
      <path d="M2 9a7 7 0 0 1 14 0" fill="none" stroke={STROKE[h]} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={`${(Math.max(0.04, pct / 100) * len).toFixed(2)} ${len}`} />
    </svg>
  );
}

/**
 * Account panel under the order form (Hyperliquid): Deposit / Withdraw, then the account summary (margin ratio with
 * a dial, equity, unrealized PnL, free collateral, maintenance margin, account leverage). Phones show it as its own
 * card. Deposit / Withdraw open the ticket's funds dialog (shared draft state).
 */
export function AccountStrip() {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  const me = useAccountAddress();
  const { data: a, isPending, fetchStatus } = useAccountView(me);
  const disconnected = isPending && fetchStatus === "idle";
  const ratio = a ? marginRatioWad(a) : undefined;
  const h = a ? health(a) : "safe";
  const pct = a ? (ratio === undefined ? 100 : Math.min(100, Number((ratio * 10_000n) / WAD) / 100)) : 0;
  const free = a ? freeCollateralWad(a) : undefined;
  // account leverage = |position notional| / equity, display only
  const lev = a && a.equity > 0n ? (((a.size < 0n ? -a.size : a.size) * (a.entryPrice || 0n)) / WAD) * WAD / a.equity : 0n;
  const money = (v: bigint | undefined) => (v === undefined ? "$0.00" : <Private kind="balance">${formatAusdWad(v)}</Private>);
  return (
    <Card as="section" aria-label="Account summary" className="h-full">
      <div className="grid grid-cols-2 gap-2">
        <Button variant="brand" disabled={!isConnected} onClick={() => setDraft({ funds: "deposit" })}>
          Deposit
        </Button>
        <Button variant="outline" disabled={!isConnected || !free} onClick={() => setDraft({ funds: "withdraw" })}>
          Withdraw
        </Button>
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <h2 className="mb-1 text-[13px] font-medium">
          Account Summary{ds.kind === "mock" && !isConnected ? " (sample)" : ""}
        </h2>
        <Line label="Margin Ratio" tip="Maintenance margin ÷ equity. At 100% anyone can liquidate the account." testId="margin-ratio">
          <span className={`inline-flex items-center gap-1.5 ${TXT[h]}`}>
            <Gauge pct={pct} h={h} />
            {!a ? "0.00%" : ratio === undefined ? "liq." : `${formatFixed(ratio * 100n, 18, 2)}%`}
          </span>
        </Line>
        <Line label="Account Equity">{money(a?.equity)}</Line>
        <Line label="Unrealized PNL">{a ? <Private kind="pnl"><NumberCell value={a.unrealizedPnl} format={formatAusdWad} signed flash={false} /></Private> : "$0.00"}</Line>
        <Line label="Free Collateral" tip="Equity minus the initial margin of your position and resting orders: what the ticket can still use.">
          {money(free)}
        </Line>
        <Line label="Maintenance Margin" tip="Below this equity the account can be liquidated.">
          {money(a?.maintenanceMargin)}
        </Line>
        <Line label="Account Leverage" tip="Position notional at entry ÷ equity.">
          {formatFixed(lev, 18, 2)}x
        </Line>
        {disconnected && ds.kind === "chain" && <p className="mt-2 text-xs text-muted">Connect a wallet to see your account.</p>}
      </div>
    </Card>
  );
}
