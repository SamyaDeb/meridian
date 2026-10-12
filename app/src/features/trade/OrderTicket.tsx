"use client";
import { Private } from "@/components/Private";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useAccount, useChainId } from "wagmi";
import { useAccountAddress, useAccountView, useDepth, useMarket, useRiskParams } from "@/data/hooks";
import { Button, Card, Chip, Notice, PillTabs, Popover, Tooltip } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { useWriteGate } from "@/components/WriteGate";
import { useStartLogin } from "@/components/Session";
import { ONBOARD_CTA, OnboardSheet, useOnboarding } from "@/components/Onboard";
import { firstTradeSizeMon } from "@/lib/onboard";
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
import { BLOCK_TIME_MS, DEFAULT_IMR_WAD, DEFAULT_MMR_WAD, WAD } from "@/lib/units";
import { usePerpMarket } from "@/data/market";
import { setDraft, useDraft } from "./draft";
import { setVenue, useVenue } from "./venue";
import { PERPL_APP_URL, PERPL_VENUE } from "@/features/chart/datafeed/perpl";
import { FundsDialog } from "./FundsDialog";
import { TriggerSection } from "@/features/triggers/TriggerSection";

const PCTS = [0n, 25n, 50n, 75n, 100n] as const;
const SLIPPAGES = [10n, 50n, 100n, 200n] as const; // bps

function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint: string }) {
  return (
    <Tooltip content={hint}>
      <label className={`inline-flex min-h-7 cursor-pointer items-center gap-2.5 text-[13px] pointer-coarse:min-h-11 ${disabled ? "opacity-40" : ""}`}>
        <input type="checkbox" className="h-3.5 w-3.5 rounded-[3px] accent-[var(--brand)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    </Tooltip>
  );
}

function Line({ label, children, tone, tip }: { label: ReactNode; children: ReactNode; tone?: string; tip?: string }) {
  return (
    <div className="flex items-center justify-between py-[3px] text-[13px]">
      {tip ? (
        <Tooltip content={tip}>
          <span className="dotted text-muted">{label}</span>
        </Tooltip>
      ) : (
        <span className="text-muted">{label}</span>
      )}
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
  return useVenue() === "perpl" ? <PerplViewOnly /> : <MeridianTicket />;
}

/** The ticket's place while the terminal shows Perpl (market dropdown): view only, nothing is routed to Perpl from here. */
function PerplViewOnly() {
  return (
    <Card className="h-full">
      <div data-testid="perpl-view-only" className="flex h-full flex-col gap-3 text-[13px]">
        <Chip tone="warn">{PERPL_VENUE} · view only</Chip>
        <p className="text-muted">
          You are watching Perpl&apos;s live MON perp chart and book on Monad mainnet, another venue. Meridian doesn&apos;t place orders on Perpl from this page.
        </p>
        <a href={PERPL_APP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center justify-center rounded-control border border-border text-text hover:bg-card-2">
          Open Perpl ↗
        </a>
        <button type="button" onClick={() => setVenue("meridian")} className="h-10 rounded-control bg-brand font-semibold text-white hover:opacity-90" data-testid="back-to-meridian">
          Trade MON-PERP on Meridian
        </button>
      </div>
    </Card>
  );
}

function MeridianTicket() {
  const { data: m } = useMarket();
  const { data: book } = useDepth(32);
  const { data: risk } = useRiskParams();
  const me = useAccountAddress();
  const { data: acct } = useAccountView(me);
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const tx = useTx();
  // K7: the selected market's book, tick and lot (ETH-PERP: 0.10 / 0.001 ETH); "MON" below = the base-unit input mode
  const pm = usePerpMarket();
  const LOT = pm.lotSizeWad;
  const TICK = pm.tickSizeWad;
  const fp = (v: bigint) => formatPriceWad(v, TICK);
  const ob = contractAddress(chainId, "OrderBook") ? pm.orderBook : undefined;
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
  const [pctUi, setPctUi] = useState(0);
  const startLogin = useStartLogin();
  const gate = useWriteGate();
  const [tosTicked, setTosTicked] = useState(false);

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
            ? `Minimum size is ${formatBaseWad(LOT, pm.sizeDp)} ${pm.base}`
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
  // K1.4: on testnet / anvil a wallet with no deposit gets the one-tap faucet + deposit, then a prefilled ≈ $50 order
  // lots the book can fill right now inside the chosen slippage (caps the first-trade prefill)
  const depthLots = (() => {
    if (!book || refPx === 0n) return undefined;
    try {
      return estimateFill(isBid ? book.asks : book.bids, 10n ** 9n, LOT, isBid, tickToPrice(slippageLimitTick(refPx, TICK, isBid, slip), TICK)).filledLots;
    } catch {
      return undefined;
    }
  })();
  const onboard = useOnboarding({
    onDone: () => {
      const size = firstTradeSizeMon(refPx || mark, LOT, undefined, depthLots);
      setUnit("MON");
      if (size) setDraft({ kind: "market", sizeIn: size });
    },
  });
  const onboarding = noDeposit && acct === null && onboard.available; // null = read and empty (undefined = still loading)
  // the ToS checkbox sits inline above the onboarding CTA (same summary link + checkbox as the write gate's dialog)
  const needsTos = onboarding && !tosTicked && !gate.accepted();
  const cta = !isConnected
    ? "Start trading"
    : onboarding
      ? onboard.ready
        ? ONBOARD_CTA
        : "Preparing your wallet…"
      : noDeposit
        ? "Deposit AUSD to trade"
        : (problem ?? `${kind === "market" ? "Market" : "Limit"} ${sideLabel}`);

  const submit = () => {
    if (!isConnected) return startLogin?.();
    if (onboarding) return onboard.start();
    if (noDeposit) return setFunds("deposit");
    tx.run(`${kind} ${sideLabel} ${lots} lots`, (p, w) => {
      if (!ob) throw new Error("no OrderBook for this chain");
      if (kind === "market") {
        if (marketTick === undefined) throw new Error("no reference price");
        return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, lots, marketTick, minFilledLotsFor(lots, allowPartial), reduceOnly] });
      }
      if (limitTick === undefined) throw new Error("invalid limit price");
      return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeLimitOrder", args: [isBid, limitTick, lots, orderFlags({ postOnly, ioc, reduceOnly })] });
    }, { opens: !reduceOnly });
  };

  const setPct = (pct: bigint) => {
    setPctUi(Number(pct));
    if (pct === 0n || free === undefined || refPx === 0n) return setSizeIn("");
    const l = reduceOnly ? (((account?.size ?? 0n) < 0n ? -(account?.size ?? 0n) : (account?.size ?? 0n)) / LOT) * pct / 100n : lotsForPercent(free, BigInt(levUsed), imr, refPx, pct, LOT);
    const base = l * LOT;
    setSizeIn(unit === "MON" ? formatFixed(base, 18, pm.sizeDp).replace(/,/g, "") : formatFixed((base * refPx) / WAD, 18, 2).replace(/,/g, ""));
  };

  const pctOfWad = (w: bigint) => `${formatFixed(w * 100n, 18, 4)}%`;
  const posSize = account?.size ?? 0n;
  const ctlBtn = "inline-flex h-8 items-center justify-center rounded-control bg-card-2 text-[13px] hover:bg-border pointer-coarse:h-11";

  return (
    <Card className="flex h-full min-h-0 flex-col" aria-label="Order ticket" bodyClassName="flex min-h-0 flex-1 flex-col">
      <div className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-1">
        {/* Hyperliquid order: margin mode · leverage · account, then order-type tabs, then the Buy / Sell toggle */}
        <div className="grid grid-cols-3 gap-2">
          <span className={ctlBtn} title="Cross margin: one AUSD account backs your position and orders (the only mode).">
            Cross
          </span>
          <Popover
            label="Leverage"
            align="end"
            triggerClassName={`${ctlBtn} num w-full`}
            trigger={`${levUsed}x`}
          >
            <div className="w-56 space-y-2 p-2">
              <label htmlFor="lev" className="flex justify-between text-xs text-muted" title="Sizes the % slider. Margin is cross: the contract checks your position and orders together.">
                Leverage <span className="num text-text">{levUsed}x of {maxLev}x max</span>
              </label>
              <input id="lev" type="range" min={1} max={maxLev} step={1} value={levUsed} onChange={(e) => setLev(Number(e.target.value))} className="w-full" />
            </div>
          </Popover>
          <span className={ctlBtn} title="Collateral and settlement currency.">
            AUSD
          </span>
        </div>

        <div className="-mx-4 mt-2 border-b border-border px-4">
          <PillTabs fill size="sm" ariaLabel="Order type" value={kind} onChange={(k) => setDraft({ kind: k })} tabs={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />
        </div>

        <div className="mt-3 grid grid-cols-2 rounded-control bg-card-2 p-0.5" role="radiogroup" aria-label="Side">
          {(["long", "short"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={side === s}
              onClick={() => setDraft({ side: s })}
              className={`h-8 rounded-[5px] text-[13px] transition-colors pointer-coarse:h-11 ${side === s ? (s === "long" ? "bg-long text-on-brand" : "bg-short text-on-brand") : "text-text hover:text-text/80"}`}
            >
              {s === "long" ? "Buy / Long" : "Sell / Short"}
            </button>
          ))}
        </div>

        <div className="mt-3 space-y-0.5">
          <Line label="Available to Trade">
            <Private kind="balance">{free !== undefined ? formatAusdWad(free) : "0.00"}</Private> AUSD
          </Line>
          <Line label="Current Position">
            <span className={posSize > 0n ? "text-long" : posSize < 0n ? "text-short" : ""}>{formatBaseWad(posSize, pm.sizeDp)} {pm.base}</span>
          </Line>
        </div>

        {kind === "limit" && (
          <div className="mt-2 flex h-10 items-center gap-2 rounded-control border border-line bg-card-2 pl-3 pr-1 focus-within:border-brand-soft pointer-coarse:h-11">
            <label htmlFor="limit-px" className="shrink-0 text-[13px] text-muted">
              Price (AUSD)
            </label>
            <input
              id="limit-px"
              aria-label="Limit price"
              inputMode="decimal"
              placeholder="0.000000"
              value={limitPx}
              onChange={(e) => setDraft({ limitPx: e.target.value })}
              className="num h-full min-w-0 flex-1 bg-transparent text-right text-[13px] outline-none"
            />
            <button
              type="button"
              className="h-7 shrink-0 rounded-control px-2 text-xs text-brand-soft hover:bg-border disabled:opacity-40"
              disabled={bestBid === undefined || bestAsk === undefined}
              onClick={() => bestBid !== undefined && bestAsk !== undefined && setDraft({ limitPx: fp((bestBid + bestAsk) / 2n).replace(/,/g, "") })}
            >
              Mid
            </button>
          </div>
        )}

        <div className="mt-2 flex h-10 items-center gap-2 rounded-control border border-line bg-card-2 pl-3 pr-1 focus-within:border-brand-soft pointer-coarse:h-11">
          <label htmlFor="size-in" className="shrink-0 text-[13px] text-muted">
            Size
          </label>
          <input
            id="size-in"
            aria-label="Size"
            inputMode="decimal"
            placeholder=""
            value={sizeIn}
            onChange={(e) => (setSizeIn(e.target.value), setPctUi(0))}
            className="num h-full min-w-0 flex-1 bg-transparent text-right text-[13px] outline-none"
          />
          <select aria-label="Size unit" value={unit} onChange={(e) => (setUnit(e.target.value as "MON" | "AUSD"), setSizeIn(""), setPctUi(0))} className="h-8 shrink-0 bg-transparent pr-1 text-[13px] outline-none">
            <option value="MON">{pm.base}</option>
            <option value="AUSD">AUSD</option>
          </select>
        </div>
        <p className="num mt-1 text-right text-[11px] text-muted">{lots > 0n ? `${formatBaseWad(lots * LOT, pm.sizeDp)} ${pm.base} · ${lots} lots` : `lot ${formatBaseWad(LOT, pm.sizeDp)} ${pm.base}`}</p>

        {/* % of available: a slider with snap points (Hyperliquid) and the number beside it */}
        <div className="mt-1 flex items-center gap-3">
          <div className="relative flex-1">
            <input
              type="range"
              aria-label="Percent of available"
              min={0}
              max={100}
              step={1}
              value={pctUi}
              disabled={free === undefined}
              onChange={(e) => setPct(BigInt(e.target.value))}
              className="w-full disabled:opacity-40"
            />
            <div className="pointer-events-none absolute inset-x-1.5 top-1/2 flex -translate-y-1/2 justify-between" aria-hidden>
              {PCTS.map((p) => (
                <span key={p.toString()} className={`h-1.5 w-1.5 rounded-full ${Number(p) <= pctUi ? "bg-brand-soft" : "bg-line"}`} />
              ))}
            </div>
          </div>
          <div className="flex h-9 w-[72px] items-center rounded-control border border-line bg-card-2 px-2 text-[13px]">
            <input
              aria-label="Percent"
              inputMode="numeric"
              value={pctUi}
              onChange={(e) => {
                const v = Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0)));
                setPct(BigInt(v));
              }}
              className="num w-full min-w-0 bg-transparent text-right outline-none"
            />
            <span className="ml-1 text-muted">%</span>
          </div>
        </div>

        <div className="mt-2 flex flex-col">
          <Toggle label="Reduce Only" checked={reduceOnly} onChange={setReduceOnly} hint="Can only shrink your position; size is clamped to it (flag 4)." />
          {kind === "limit" && (
            <>
              <Toggle label="Post Only" checked={postOnly} disabled={ioc} onChange={setPostOnly} hint="Rests on the book or is rejected; never takes liquidity (flag 1)." />
              <Toggle label="Immediate or Cancel" checked={ioc} disabled={postOnly} onChange={setIoc} hint="Fills what it can now, the rest is cancelled (flag 2)." />
            </>
          )}
          {kind === "market" && <Toggle label="Allow Partial Fill" checked={allowPartial} onChange={setAllowPartial} hint="Off: the order reverts unless it fills completely inside the slippage bound." />}
        </div>

        {pm.primary && <TriggerSection account={account} market={m} />}

        {/* pushes the button and the order details to the bottom of the column (level with the chart's bottom edge) */}
        <div className="min-h-4 flex-1" />

        {onboarding && (needsTos || tosTicked) && (
          <label className="mb-1 flex min-h-11 items-center gap-3 text-xs text-muted">
            <input
              type="checkbox"
              checked={tosTicked}
              onChange={(e) => {
                setTosTicked(e.target.checked);
                if (e.target.checked) gate.accept();
              }}
              className="h-4 w-4 shrink-0 accent-[var(--brand)]"
            />
            <span>
              I have read and accept the{" "}
              <Link href="/terms" target="_blank" className="text-brand-soft underline">
                terms and risks
              </Link>
            </span>
          </label>
        )}
        <Button
          variant={!isConnected || onboarding ? "brand" : isBid ? "long" : "short"}
          block
          className="h-10! min-h-10! text-[13px]!"
          disabled={(!isConnected && !startLogin) || tx.busy || onboard.busy || needsTos || (onboarding && !onboard.ready) || (isConnected && !noDeposit && problem !== undefined)}
          loading={tx.busy || onboard.busy}
          onClick={submit}
          data-testid="place-order"
        >
          {cta}
        </Button>

        <div className="mt-3 border-t border-border pt-2" data-testid="ticket-preview">
          <Line label="Liquidation Price" tone="text-warn">
            <Private kind="liq">{preview?.liqPriceWad ? fp(preview.liqPriceWad) : "N/A"}</Private>
          </Line>
          <Line label="Order Value">{preview ? `${formatAusdWad(preview.notionalWad)} AUSD` : "N/A"}</Line>
          <Line label="Margin Required">{preview ? `${formatAusdWad(preview.marginWad)} AUSD` : "N/A"}</Line>
          {kind === "market" && (
            <Line label="Slippage" tip="Estimated price impact against the book / the most the order may move the price before it reverts. Click Max to change it.">
              <span className="text-brand-soft">
                Est: {impactBps !== undefined ? formatFixed(impactBps * 10n ** 16n, 18, 2) : "0"}% / Max:{" "}
                <button
                  type="button"
                  aria-label="Max slippage"
                  className="underline decoration-dotted underline-offset-2 hover:text-text"
                  onClick={() => setSlip(SLIPPAGES[(SLIPPAGES.indexOf(slip as (typeof SLIPPAGES)[number]) + 1) % SLIPPAGES.length]!)}
                >
                  {formatFixed(slip * 10n ** 16n, 18, 2)}%
                </button>
              </span>
            </Line>
          )}
          <Line label="Fees" tip="Taker / maker fee rate, from the onchain risk parameters. A negative maker fee is a rebate.">
            {risk ? `${pctOfWad(risk.takerFee)} / ${pctOfWad(risk.makerFee)}` : "—"}
          </Line>
          <Line label="Funding per Block" tip="Meridian settles funding every block (~300 ms)." tone={preview ? (preview.fundingPerBlockWad > 0n ? "text-short" : preview.fundingPerBlockWad < 0n ? "text-long" : "") : ""}>
            {preview ? `${preview.fundingPerBlockWad > 0n ? "-" : preview.fundingPerBlockWad < 0n ? "+" : ""}${formatFixed(preview.fundingPerBlockWad < 0n ? -preview.fundingPerBlockWad : preview.fundingPerBlockWad, 18, 8)}` : "N/A"}
          </Line>
          {!risk && <p className="pt-1 text-[10px] text-warn">Risk params not read yet: margin uses the launch defaults (5x cap).</p>}
        </div>

        {/* the layout footer is hidden on the full-height terminal: the Terms link stays reachable here */}
        <Link href="/terms" className="mt-1 hidden min-h-6 items-center justify-end text-[11px] text-muted underline xl:flex">
          Terms &amp; risks
        </Link>
        {tx.status && (
          <Notice tone={tx.status.includes("failed") ? "danger" : "info"} className="mt-2">
            <span className="num break-all" data-testid="tx-status">
              {tx.status}
            </span>
          </Notice>
        )}
      </div>
      <OnboardSheet o={onboard} />
      <FundsDialog mode={funds ?? "deposit"} open={funds !== null} onClose={() => setFunds(null)} freeCollateralWad={free} />
    </Card>
  );
}
