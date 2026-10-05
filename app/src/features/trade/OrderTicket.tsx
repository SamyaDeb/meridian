"use client";
import { Private } from "@/components/Private";
import { useState, type ReactNode } from "react";
import { useAccount, useChainId } from "wagmi";
import { useAccountAddress, useAccountView, useDepth, useMarket, useRiskParams } from "@/data/hooks";
import { Button, Card, Chip, Notice, PillTabs, Tooltip } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { orderBookAbi } from "@/lib/abi";
import { sendTx } from "@/lib/tx";
import { priceToTick, tickToPrice } from "@/lib/orders";
import { freeCollateralWad } from "@/lib/account";
import { formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, parseFixed } from "@/lib/format";
import {
  estimateFill,
  imForLots,
  lotsForPercent,
  lotsFromInput,
  minFilledLotsFor,
  orderFlags,
  postOnlyWouldCross,
  previewOrder,
  reduceOnlyLots,
  referencePrice,
  slippageLimitTick,
} from "@/lib/ticket";
import { BLOCK_TIME_MS, DEFAULT_IMR_WAD, DEFAULT_MMR_WAD, PERP_LOT_SIZE_WAD as LOT, PERP_TICK_SIZE_WAD as TICK, WAD } from "@/lib/units";
import { setDraft, useDraft } from "./draft";
import { FundsDialog } from "./FundsDialog";
import { TriggerSection } from "@/features/triggers/TriggerSection";

const PCTS = [0n, 25n, 50n, 75n, 100n] as const;
const SLIPPAGES = [10n, 50n, 100n, 200n] as const; // bps

function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint: string }) {
  return (
    <Tooltip content={hint}>
      <label className={`inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11px] pointer-coarse:min-h-11 ${disabled ? "opacity-40" : ""} ${checked ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted"}`}>
        <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--brand)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    </Tooltip>
  );
}

function Line({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className={`num ${tone ?? ""}`}>{children}</span>
    </div>
  );
}

/**
 * Order ticket (FRONTEND_TRADE_PLAN §6.3): Long/Short, Market/Limit, size in MON or AUSD with %-of-available,
 * leverage to the onchain cap, post-only / IOC / reduce-only (flags 1 / 2 / 4), slippage → limitTick + minFilledLots,
 * live preview. Every write goes through useTx (ToS gate, geoblock, estimate × 1.2 gas).
 */
export function OrderTicket() {
  const { data: m } = useMarket();
  const { data: book } = useDepth(32);
  const { data: risk } = useRiskParams();
  const me = useAccountAddress();
  const { data: acct } = useAccountView(me);
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const tx = useTx();
  const ob = contractAddress(chainId, "OrderBook");
  const { side, kind, limitPx, sizeIn, funds } = useDraft();
  const setSizeIn = (v: string) => setDraft({ sizeIn: v });
  const setFunds = (v: "deposit" | "withdraw" | null) => setDraft({ funds: v });
  const [unit, setUnit] = useState<"MON" | "AUSD">("MON");
  const [lev, setLev] = useState(3);
  const [postOnly, setPostOnly] = useState(false);
  const [ioc, setIoc] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [slip, setSlip] = useState<bigint>(50n);
  const [allowPartial, setAllowPartial] = useState(false);

  const isBid = side === "long";
  const imr = risk?.imr ?? DEFAULT_IMR_WAD;
  const mmr = risk?.mmr ?? DEFAULT_MMR_WAD;
  const maxLev = Number((WAD / imr) as bigint) || 1; // onchain cap = 1/imr (5x at launch)
  const levUsed = Math.min(lev, maxLev);
  const bestBid = book?.bids[0]?.priceWad;
  const bestAsk = book?.asks[0]?.priceWad;
  const mark = m?.lastMarkPrice ?? 0n;
  const account = acct ?? undefined;
  const free = account ? freeCollateralWad(account) : undefined;

  const limitWad = kind === "limit" ? parseFixed(limitPx, 18) : undefined;
  const limitTick = (() => {
    if (limitWad === undefined || limitWad === 0n) return undefined;
    try {
      return priceToTick(limitWad, TICK, isBid ? "bid" : "ask");
    } catch {
      return undefined;
    }
  })();
  const refPx = kind === "market" ? referencePrice(isBid, bestBid, bestAsk, mark) : limitTick !== undefined ? tickToPrice(limitTick, TICK) : 0n;
  const typed = parseFixed(sizeIn, 18);
  let lots = typed !== undefined ? lotsFromInput(typed, unit, refPx || mark, LOT) : 0n;
  if (reduceOnly) lots = reduceOnlyLots(account?.size ?? 0n, isBid, lots, LOT);

  const marketTick = (() => {
    if (kind !== "market" || refPx === 0n) return undefined;
    try {
      return slippageLimitTick(refPx, TICK, isBid, slip);
    } catch {
      return undefined;
    }
  })();
  const fill = kind === "market" && marketTick !== undefined && book ? estimateFill(isBid ? book.asks : book.bids, lots, LOT, isBid, tickToPrice(marketTick, TICK)) : undefined;
  const execPx = kind === "market" ? (fill && fill.filledLots > 0n ? fill.avgPriceWad : refPx) : refPx;

  const preview =
      lots > 0n && execPx > 0n && m
        ? previewOrder({
            account,
            isBid,
            lots,
            lotSize: LOT,
            priceWad: execPx,
            markWad: m.lastMarkPrice,
            indexWad: m.lastIndexPrice,
            ratePerSecondWad: m.lastRate,
            blockTimeMs: m.blockTimeMs > 0n ? m.blockTimeMs : BigInt(BLOCK_TIME_MS),
            imrWad: imr,
            mmrWad: mmr,
            feeRateWad: kind === "limit" && postOnly ? (risk?.makerFee ?? 0n) : (risk?.takerFee ?? 0n),
          })
        : undefined;
  const impactBps = fill && fill.filledLots > 0n && mark > 0n ? (((fill.avgPriceWad > mark ? fill.avgPriceWad - mark : mark - fill.avgPriceWad) * 10_000n) / mark) : undefined;

  // validation: the first problem blocks the CTA and is shown as its label
  const problem: string | undefined = !isConnected
    ? undefined
    : m?.paused
      ? "Market paused"
      : typed === undefined || typed === 0n
        ? "Enter a size"
        : reduceOnly && lots === 0n
          ? "Reduce-only: no position to reduce on this side"
          : lots === 0n
            ? `Minimum size is ${formatBaseWad(LOT, 0)} MON`
            : kind === "limit" && limitTick === undefined
              ? "Enter a limit price"
              : kind === "limit" && postOnly && postOnlyWouldCross(isBid, tickToPrice(limitTick!, TICK), bestBid, bestAsk)
                ? "Post-only would cross the book"
                : kind === "market" && (isBid ? bestAsk : bestBid) === undefined
                  ? "No liquidity on that side"
                  : kind === "market" && !allowPartial && fill && fill.filledLots < lots
                    ? "Not enough depth inside your slippage"
                    : !reduceOnly && free !== undefined && imForLots(lots, LOT, execPx, imr) > free
                      ? "Not enough free collateral"
                      : undefined;
  const noDeposit = isConnected && account === undefined;
  const sideLabel = isBid ? "long" : "short";
  const cta = !isConnected ? `Log in to ${sideLabel}` : noDeposit ? "Deposit AUSD to trade" : (problem ?? `${kind === "market" ? "Market" : "Limit"} ${sideLabel}`);

  const submit = () => {
    if (noDeposit) return setFunds("deposit");
    tx.run(`${kind} ${sideLabel} ${lots} lots`, (p, w) => {
      if (!ob) throw new Error("no OrderBook for this chain");
      if (kind === "market") {
        if (marketTick === undefined) throw new Error("no reference price");
        return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, lots, marketTick, minFilledLotsFor(lots, allowPartial), reduceOnly] });
      }
      if (limitTick === undefined) throw new Error("invalid limit price");
      return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeLimitOrder", args: [isBid, limitTick, lots, orderFlags({ postOnly, ioc, reduceOnly })] });
    });
  };

  const setPct = (pct: bigint) => {
    if (pct === 0n || free === undefined || refPx === 0n) return setSizeIn("");
    const l = reduceOnly ? (((account?.size ?? 0n) < 0n ? -(account?.size ?? 0n) : (account?.size ?? 0n)) / LOT) * pct / 100n : lotsForPercent(free, BigInt(levUsed), imr, refPx, pct, LOT);
    const base = l * LOT;
    setSizeIn(unit === "MON" ? formatFixed(base, 18, 0).replace(/,/g, "") : formatFixed((base * refPx) / WAD, 18, 2).replace(/,/g, ""));
  };

  return (
    <Card className="flex h-full min-h-0 flex-col" aria-label="Order ticket" bodyClassName="flex min-h-0 flex-1 flex-col gap-3">
      <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-auto px-1 pb-1">
      <div className="grid grid-cols-2 gap-1 rounded-full bg-card-2 p-1" role="radiogroup" aria-label="Side">
        {(["long", "short"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => setDraft({ side: s })}
            className={`h-9 rounded-full text-sm font-semibold capitalize pointer-coarse:h-11 ${side === s ? (s === "long" ? "bg-long text-on-brand" : "bg-short text-on-brand") : "text-muted"}`}
          >
            {s === "long" ? "▲ Long" : "▼ Short"}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <PillTabs size="sm" ariaLabel="Order type" value={kind} onChange={(k) => setDraft({ kind: k })} tabs={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />
        <Chip>cross · {formatFixed(BigInt(levUsed) * WAD, 18, 0)}x</Chip>
      </div>

      {kind === "limit" && (
        <div>
          <label htmlFor="limit-px" className="text-xs text-muted">
            Limit price (AUSD)
          </label>
          <div className="mt-1 flex gap-1.5">
            <input
              id="limit-px"
              aria-label="Limit price"
              inputMode="decimal"
              placeholder="0.000000"
              value={limitPx}
              onChange={(e) => setDraft({ limitPx: e.target.value })}
              className="num h-10 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm pointer-coarse:h-11"
            />
            <Button size="sm" className="h-10" disabled={bestBid === undefined || bestAsk === undefined} onClick={() => bestBid !== undefined && bestAsk !== undefined && setDraft({ limitPx: formatPriceWad((bestBid + bestAsk) / 2n).replace(/,/g, "") })}>
              Mid
            </Button>
            <Button size="sm" className="h-10" disabled={(isBid ? bestBid : bestAsk) === undefined} onClick={() => setDraft({ limitPx: formatPriceWad((isBid ? bestBid : bestAsk)!).replace(/,/g, "") })}>
              {isBid ? "Bid" : "Ask"}
            </Button>
          </div>
        </div>
      )}

      <div>
        <label htmlFor="size-in" className="text-xs text-muted">
          Size
          <span className="num float-right">{lots > 0n ? `${formatBaseWad(lots * LOT, 0)} MON · ${lots} lots` : `lot ${formatBaseWad(LOT, 0)} MON`}</span>
        </label>
        <div className="mt-1 flex gap-1.5">
          <input id="size-in" aria-label="Size" inputMode="decimal" placeholder="0" value={sizeIn} onChange={(e) => setSizeIn(e.target.value)} className="num h-10 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm pointer-coarse:h-11" />
          <select aria-label="Size unit" value={unit} onChange={(e) => (setUnit(e.target.value as "MON" | "AUSD"), setSizeIn(""))} className="h-10 rounded-control bg-card-2 px-2 text-xs pointer-coarse:h-11">
            <option value="MON">MON</option>
            <option value="AUSD">AUSD</option>
          </select>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-1" role="group" aria-label="Percent of available">
          {PCTS.map((p) => (
            <button key={p.toString()} type="button" disabled={free === undefined && p > 0n} onClick={() => setPct(p)} className="h-7 rounded-full bg-card-2 text-[11px] text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11">
              {p.toString()}%
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="lev" className="text-xs text-muted" title="Sizes the % buttons. Margin is cross: the contract checks your position and orders together.">
          Leverage <span className="num float-right text-text">{levUsed}x of {maxLev}x max</span>
        </label>
        <input id="lev" type="range" min={1} max={maxLev} step={1} value={levUsed} onChange={(e) => setLev(Number(e.target.value))} list="lev-marks" className="mt-1 w-full" />
        <datalist id="lev-marks">
          {Array.from({ length: maxLev }, (_, i) => (
            <option key={i} value={i + 1} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {kind === "limit" && (
          <>
            <Toggle label="Post-only" checked={postOnly} disabled={ioc} onChange={setPostOnly} hint="Rests on the book or is rejected; never takes liquidity (flag 1)." />
            <Toggle label="IOC" checked={ioc} disabled={postOnly} onChange={setIoc} hint="Immediate or cancel: fills what it can now, the rest is cancelled (flag 2)." />
          </>
        )}
        <Toggle label="Reduce-only" checked={reduceOnly} onChange={setReduceOnly} hint="Can only shrink your position; size is clamped to it (flag 4)." />
        {kind === "market" && <Toggle label="Allow partial" checked={allowPartial} onChange={setAllowPartial} hint="Off: the order reverts unless it fills completely inside the slippage bound." />}
      </div>

      {kind === "market" && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">Max slippage</span>
          <div className="flex gap-1" role="radiogroup" aria-label="Max slippage">
            {SLIPPAGES.map((s) => (
              <button key={s.toString()} type="button" role="radio" aria-checked={slip === s} onClick={() => setSlip(s)} className={`num h-7 rounded-full px-2 text-[11px] pointer-coarse:h-11 pointer-coarse:min-w-11 ${slip === s ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted"}`}>
                {formatFixed(s * 10n ** 16n, 18, 1)}%
              </button>
            ))}
          </div>
        </div>
      )}

        <TriggerSection account={account} market={m} />
      </div>
      <div className="shrink-0 space-y-2">
      <div className="rounded-inner bg-card-2 px-3 py-2" data-testid="ticket-preview">
        <Line label="Notional">{preview ? `${formatAusdWad(preview.notionalWad)} AUSD` : "—"}</Line>
        <Line label="Margin required">{preview ? `${formatAusdWad(preview.marginWad)} AUSD` : "—"}</Line>
        <Line label={kind === "limit" && postOnly ? "Maker fee" : "Taker fee"}>{preview ? `${formatAusdWad(preview.feeWad < 0n ? -preview.feeWad : preview.feeWad)} AUSD${preview.feeWad < 0n ? " rebate" : ""}` : "—"}</Line>
        {kind === "market" && (
          <Line label="Est. price · impact">{fill && fill.filledLots > 0n ? `${formatPriceWad(fill.avgPriceWad)} · ${impactBps !== undefined ? formatFixed(impactBps * 10n ** 16n, 18, 2) : "—"}%` : "—"}</Line>
        )}
        <Line label="Est. liq. price" tone="text-warn">
          <Private kind="liq">{preview?.liqPriceWad ? formatPriceWad(preview.liqPriceWad) : "—"}</Private>
        </Line>
        <Line label="Funding per block" tone={preview ? (preview.fundingPerBlockWad > 0n ? "text-short" : preview.fundingPerBlockWad < 0n ? "text-long" : "") : ""}>
          {preview ? `${preview.fundingPerBlockWad > 0n ? "you pay " : preview.fundingPerBlockWad < 0n ? "you earn " : ""}${formatFixed(preview.fundingPerBlockWad < 0n ? -preview.fundingPerBlockWad : preview.fundingPerBlockWad, 18, 8)} AUSD` : "—"}
        </Line>
        {!risk && <p className="pt-1 text-[10px] text-warn">Risk params not read yet: margin uses the launch defaults (5x cap).</p>}
      </div>

      <Button
        variant={isBid ? "long" : "short"}
        size="lg"
        block
        disabled={!isConnected || tx.busy || (!noDeposit && problem !== undefined)}
        loading={tx.busy}
        onClick={submit}
        data-testid="place-order"
      >
        {cta}
      </Button>

      {isConnected && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={() => setFunds("deposit")}>
            Deposit
          </Button>
          <Button size="sm" disabled={!free} onClick={() => setFunds("withdraw")}>
            Withdraw
          </Button>
        </div>
      )}
      {tx.status && (
        <Notice tone={tx.status.includes("failed") ? "danger" : "info"}>
          <span className="num break-all" data-testid="tx-status">
            {tx.status}
          </span>
        </Notice>
      )}
      </div>
      <FundsDialog mode={funds ?? "deposit"} open={funds !== null} onClose={() => setFunds(null)} freeCollateralWad={free} />
    </Card>
  );
}
