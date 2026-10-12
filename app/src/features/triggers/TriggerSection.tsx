"use client";
import { useState } from "react";
import { Button, Chip, Notice, PillTabs } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import type { AccountSummary, Market } from "@/data/types";
import { formatAusdToken, formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, parseFixed } from "@/lib/format";
import { abs } from "@/lib/math";
import { PERP_LOT_SIZE_WAD as LOT, PERP_TICK_SIZE_WAD as TICK } from "@/lib/units";
import { MAX_TRIGGERS_PER_ACCOUNT, type TriggerKind } from "./abi";
import { closingIsBid, expiryBlockFor, pctFromTrigger, pnlAtTrigger, triggerFromPct, wouldFire, worstTick } from "./math";
import { useTriggers } from "./useTriggers";

const EXPIRIES = [
  { id: "1d", label: "1 day", sec: 86_400n },
  { id: "7d", label: "7 days", sec: 604_800n },
  { id: "30d", label: "30 days", sec: 2_592_000n },
] as const;
const SLIP = 100n; // worst price 1 % beyond the trigger (the user's limitTick)

/**
 * Stop-loss / take-profit for the open position (CR-012): a reduce-only market order the manager sends when the
 * onchain index price crosses the trigger, at no worse than the worst price shown. Hidden when the feature is off.
 */
export function TriggerSection({ account, market }: { account: AccountSummary | undefined; market: Market | undefined }) {
  const { client, triggers, tip, refetch } = useTriggers();
  const tx = useTx();
  const [kind, setKind] = useState<TriggerKind>("StopMarket");
  const [unit, setUnit] = useState<"%" | "AUSD">("%");
  const [val, setVal] = useState("5");
  const [pct, setPct] = useState(100n);
  const [exp, setExp] = useState<(typeof EXPIRIES)[number]["id"]>("7d");
  if (!client) return null;
  if (!account || account.size === 0n || !market)
    return (
      <p className="text-[11px] text-muted" data-testid="triggers-need-position">
        Stop / take-profit: open a position first (triggers only reduce a position).
      </p>
    );
  const long = account.size > 0n;
  const ref = account.entryPrice > 0n ? account.entryPrice : market.lastMarkPrice;
  const trigger = (() => {
    if (unit === "AUSD") return parseFixed(val, 18);
    const bps = parseFixed(val, 2); // "5" ⇒ 500 bps
    return bps === undefined ? undefined : triggerFromPct(kind, long, ref, bps);
  })();
  const lots = ((abs(account.size) / LOT) * pct) / 100n;
  const closeBid = closingIsBid(account.size);
  let limitTick: number | undefined;
  try {
    limitTick = trigger ? worstTick(trigger, TICK, closeBid, SLIP) : undefined;
  } catch {
    limitTick = undefined;
  }
  const immediate = trigger !== undefined && wouldFire(kind, long, market.lastIndexPrice, trigger);
  const beyondLiq = kind === "StopMarket" && trigger !== undefined && account.liquidationPrice > 0n && (long ? trigger <= account.liquidationPrice : trigger >= account.liquidationPrice);
  const full = (triggers?.length ?? 0) >= MAX_TRIGGERS_PER_ACCOUNT;
  const problem = !trigger ? "Enter a trigger price" : lots === 0n ? "Size rounds to 0 lots" : limitTick === undefined ? "Price outside the tick range" : immediate ? "Would fire immediately at the current index" : full ? `At most ${MAX_TRIGGERS_PER_ACCOUNT} open triggers` : undefined;
  const label = kind === "StopMarket" ? "stop" : "take-profit";
  const submit = () =>
    tx.run(`${label} ${lots} lots${client.mode === "mock" ? " (mock, nothing sent)" : ""}`, async (p, w) => {
      const r = await client.create(p, w, { kind, isBid: closeBid, lots, triggerPriceWad: trigger!, limitTick: limitTick!, expiryBlock: expiryBlockFor(market.lastFundingBlock, EXPIRIES.find((e) => e.id === exp)!.sec, market.blockTimeMs) });
      void refetch();
      return r;
    });
  return (
    <section aria-label="Stop and take-profit" className="space-y-2 rounded-inner border border-border p-3" data-testid="trigger-section">
      <div className="flex items-center justify-between gap-2">
        <PillTabs size="sm" ariaLabel="Trigger type" value={kind} onChange={setKind} tabs={[{ id: "StopMarket", label: "Stop-loss" }, { id: "TakeProfitMarket", label: "Take-profit" }]} />
        {client.mode === "mock" && <Chip tone="warn">mock: nothing sent</Chip>}
      </div>
      <div className="flex gap-1.5">
        <input aria-label="Trigger price" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} className="num h-9 min-w-0 flex-1 rounded-control border border-line bg-card-2 px-3 text-sm pointer-coarse:h-11" />
        <select aria-label="Trigger unit" value={unit} onChange={(e) => (setUnit(e.target.value as "%" | "AUSD"), setVal(e.target.value === "AUSD" && trigger ? formatPriceWad(trigger).replace(/,/g, "") : "5"))} className="h-9 rounded-control border border-line bg-card-2 px-2 text-xs pointer-coarse:h-11">
          <option value="%">% from entry</option>
          <option value="AUSD">AUSD</option>
        </select>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Share of position">
        {[25n, 50n, 100n].map((x) => (
          <button key={x.toString()} type="button" aria-pressed={pct === x} onClick={() => setPct(x)} className={`h-7 rounded-control text-[11px] pointer-coarse:h-11 ${pct === x ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted"}`}>
            {x.toString()}% of position
          </button>
        ))}
      </div>
      <label className="flex items-center justify-between text-[11px] text-muted">
        Expires after
        <select aria-label="Trigger expiry" value={exp} onChange={(e) => setExp(e.target.value as typeof exp)} className="h-7 rounded-control border border-line bg-card-2 px-2 text-[11px] pointer-coarse:h-11">
          {EXPIRIES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <dl className="num space-y-0.5 text-[11px]">
        <div className="flex justify-between"><dt className="text-muted">Trigger (index price)</dt><dd>{trigger ? `${formatPriceWad(trigger)} · ${formatFixed(pctFromTrigger(ref, trigger) * 10n ** 16n, 18, 2)}%` : "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Worst fill price</dt><dd>{limitTick !== undefined ? formatPriceWad(BigInt(limitTick) * TICK) : "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Size</dt><dd>{formatBaseWad(lots * LOT, 0)} MON ({lots.toString()} lots)</dd></div>
        <div className="flex justify-between"><dt className="text-muted">PnL at trigger (est.)</dt><dd>{trigger ? formatAusdWad(pnlAtTrigger(account.size, account.entryPrice, trigger, lots * LOT)) : "—"} AUSD</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Execution tip (prepaid, refunded on cancel / expiry)</dt><dd>{tip !== undefined ? `${formatAusdToken(tip)} AUSD` : "—"}</dd></div>
      </dl>
      <Notice tone="warn">
        <strong>A stop is not liquidation protection.</strong> It fires only when someone executes it after the index crosses the trigger, and only fills inside the worst price.
        {beyondLiq && " This stop is at or beyond your liquidation price: liquidation would come first."}
      </Notice>
      <Button variant="brand" block disabled={!tx.ready || tx.busy || problem !== undefined} loading={tx.busy} onClick={submit} data-testid="place-trigger">
        {problem ?? `Place ${label} (reduce-only)`}
      </Button>
      {tx.status && (
        <p className="num break-all text-[11px] text-muted" data-testid="trigger-tx-status">
          {tx.status}
        </p>
      )}
    </section>
  );
}
