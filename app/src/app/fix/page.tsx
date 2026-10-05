"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { useAccountAddress, useMarket, useSwap } from "@/data/hooks";
import { Row, toneOf } from "@/components/ui";
import { Button, Card, Chip, Notice, Skeleton } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { orderBookAbi } from "@/lib/abi";
import { closeOrder, marketLimitTick, swapAprToTick, swapTickToAprWad } from "@/lib/earnfix";
import { formatAprWad, formatAusdWad, formatBaseWad, formatDuration, formatFixed, formatSignedAusdWad, parseFixed } from "@/lib/format";

/** Per-block accrual on small notionals is ~1e-8 AUSD: show 8 dp so it visibly ticks. */
const fmtAccrual = (wad: bigint): string => `${wad < 0n ? "−" : wad > 0n ? "+" : ""}${formatFixed(wad < 0n ? -wad : wad, 18, 8)}`;
import { swapPositionValueWad } from "@/lib/math";
import { sendTx, swapDeposit, swapWithdraw } from "@/lib/tx";

const SWAP_TICK = 10n ** 14n; // 1 bp APR (WS-05 deploy wiring)
const SWAP_LOT_MON = 1_000n; // 1 lot = 1,000 MON notional
const SWAP_LOT_WAD = SWAP_LOT_MON * 10n ** 18n;
const SLIPPAGE_TICKS = 20; // market orders take up to 20 bps APR beyond the best level

/** Best bid/ask ticks of the swap book (contract view getDepth). */
function useSwapBook(orderBook: `0x${string}` | undefined) {
  const pub = usePublicClient();
  return useQuery({
    queryKey: ["swapBook", orderBook],
    enabled: Boolean(pub && orderBook),
    refetchInterval: 1_000,
    queryFn: async () => {
      const read = (isBid: boolean) => pub!.readContract({ address: orderBook!, abi: orderBookAbi, functionName: "getDepth", args: [isBid, 1n] });
      const [[bids], [asks]] = await Promise.all([read(true), read(false)]);
      return { bestBid: bids[0], bestAsk: asks[0] };
    },
  });
}

export default function FixPage() {
  const me = useAccountAddress();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { data: m } = useMarket();
  const { data: swap } = useSwap(me);
  const tx = useTx();
  const swapMarket = contractAddress(chainId, "FundingSwapMarket");
  const swapBook = contractAddress(chainId, "SwapOrderBook");
  const ausd = contractAddress(chainId, "AUSD");
  const { data: book } = useSwapBook(swapBook);
  const [lots, setLots] = useState("2");
  const [limitApr, setLimitApr] = useState("");
  const [collat, setCollat] = useState("100");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const tau = swap ? Math.max(0, swap.info.maturityTimestamp - now) : 0;
  const maturity = swap ? new Date(swap.info.maturityTimestamp * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const matured = swap?.stats.matured ?? false;
  const pos = swap?.positions[0];
  const nLots = BigInt(Math.max(0, Math.floor(Number(lots) || 0)));

  const order = (isBid: boolean, kind: "market" | "limit") =>
    tx.run(`${isBid ? "pay" : "receive"} fixed ${nLots} lot${nLots === 1n ? "" : "s"} (${kind})`, (p, w) => {
      if (!swapBook) throw new Error("no swap market on this chain");
      if (nLots === 0n) throw new Error("enter a size in lots");
      if (kind === "limit") {
        const apr = parseFixed(limitApr, 16); // "12.5" (%) → WAD
        if (apr === undefined) throw new Error("enter a fixed APR in %");
        return sendTx(p, w, { address: swapBook, abi: orderBookAbi, functionName: "placeLimitOrder", args: [isBid, swapAprToTick(apr, SWAP_TICK, isBid), nLots, 0] });
      }
      const lim = marketLimitTick(isBid, isBid ? book?.bestAsk : book?.bestBid, SLIPPAGE_TICKS);
      if (lim === null) throw new Error("no liquidity on the other side");
      return sendTx(p, w, { address: swapBook, abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, nLots, lim, 0n, false] });
    });
  const close = () =>
    tx.run("close swap (reduce-only)", (p, w) => {
      const c = pos ? closeOrder(pos.size, SWAP_LOT_WAD) : null;
      if (!swapBook || !c) throw new Error("no open swap");
      const lim = marketLimitTick(c.isBid, c.isBid ? book?.bestAsk : book?.bestBid, SLIPPAGE_TICKS);
      if (lim === null) throw new Error("no liquidity on the other side");
      return sendTx(p, w, { address: swapBook, abi: orderBookAbi, functionName: "placeMarketOrder", args: [c.isBid, c.lots, lim, 0n, true] });
    });
  const moveCollateral = (dir: "deposit" | "withdraw") =>
    tx.run(`${dir} ${collat} AUSD (swap margin)`, (p, w) => {
      const a = parseFixed(collat, 6);
      if (!swapMarket || !ausd) throw new Error("no swap market on this chain");
      if (a === undefined || a === 0n) throw new Error("enter an amount");
      return dir === "deposit" ? swapDeposit(p, w, ausd, swapMarket, a) : swapWithdraw(p, w, swapMarket, a);
    });

  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <h1 className="text-xl font-semibold">Fix your funding</h1>
        <p className="text-xs text-muted">Funding swaps: trade the per-block floating rate for a fixed APR until maturity.</p>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-2">
      <Card title="Swap market" right={swap ? <Chip tone={matured ? "warn" : "brand"}>{matured ? "matured" : "open"}</Chip> : undefined}>
        {!swap || !m ? (
          // same height as the loaded card at 390 px (stats + order entry), so the margin card doesn't jump (CLS)
          <Skeleton className="h-[376px] w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted">Fixed (market)</div>
                <div className="num text-2xl font-semibold" data-testid="swap-mark-apr">
                  {formatAprWad(swap.stats.markAprWad)}
                </div>
                <div className="text-[11px] text-muted">until {maturity}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Realized funding 8h</div>
                <div className="num text-2xl font-semibold">{swap.stats.realizedApr8hWad === undefined ? "—" : formatAprWad(swap.stats.realizedApr8hWad)}</div>
                <div className="text-[11px] text-muted">from the funding-rate oracle</div>
              </div>
            </div>
            <div className="mt-3 border-t border-border pt-2">
              <Row label="Matures in" value={matured ? "Matured: close and withdraw only" : formatDuration(tau)} tone={matured ? "warn" : undefined} />
              <Row
                label="Book"
                value={
                  book
                    ? `${book.bestBid ? formatAprWad(swapTickToAprWad(book.bestBid, SWAP_TICK)) : "—"} / ${book.bestAsk ? formatAprWad(swapTickToAprWad(book.bestAsk, SWAP_TICK)) : "—"}`
                    : "—"
                }
              />
              <Row label="Open interest" value={`${formatBaseWad(swap.stats.openInterestWad, 0)} MON`} />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label htmlFor="swap-lots" className="text-xs text-muted">
                Size (lots of {SWAP_LOT_MON.toString()} MON)
              </label>
              <input id="swap-lots" inputMode="numeric" value={lots} onChange={(e) => setLots(e.target.value)} className="num h-11 w-20 rounded-control bg-card-2 px-3 text-sm" />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="long" size="lg" disabled={!isConnected || matured || tx.busy || !book?.bestAsk} onClick={() => order(true, "market")}>
                Pay fixed {book?.bestAsk ? formatAprWad(swapTickToAprWad(book.bestAsk, SWAP_TICK)) : ""}
              </Button>
              <Button variant="short" size="lg" disabled={!isConnected || matured || tx.busy || !book?.bestBid} onClick={() => order(false, "market")}>
                Receive fixed {book?.bestBid ? formatAprWad(swapTickToAprWad(book.bestBid, SWAP_TICK)) : ""}
              </Button>
            </div>
            <div className="mt-2 flex gap-2">
              <input aria-label="Limit fixed APR (%)" inputMode="decimal" placeholder="Limit APR %" value={limitApr} onChange={(e) => setLimitApr(e.target.value)} className="num h-11 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm" />
              <Button disabled={!isConnected || matured || tx.busy} onClick={() => order(true, "limit")}>
                Bid
              </Button>
              <Button disabled={!isConnected || matured || tx.busy} onClick={() => order(false, "limit")}>
                Offer
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted">Pay fixed = receive the floating MON-PERP funding: a long perp&apos;s funding cost becomes fixed.</p>
          </>
        )}
      </Card>

      {pos && (pos.size !== 0n || pos.fixedAprNotional !== 0n) && (
        <Card title="Your swap">
          {(() => {
            const value = m ? swapPositionValueWad(pos.size, pos.fixedAprNotional, swap!.stats.markAprWad, m.lastIndexPrice, BigInt(tau)) : 0n;
            return pos.lockedSpread ? (
              // q = 0, K ≠ 0: a locked spread, not zero (MATH_SPEC §6.2)
              <p className="num text-lg font-semibold text-long">
                Locked {formatSignedAusdWad(value)} AUSD until {maturity}
              </p>
            ) : (
              <>
                <Row label="Side" value={pos.size > 0n ? "Pay fixed (long)" : "Receive fixed (short)"} />
                <Row label="Size" value={`${formatBaseWad(pos.size < 0n ? -pos.size : pos.size, 0)} MON`} />
                <Row label="Your fixed APR" value={pos.avgFixedAprWad === undefined ? "—" : formatAprWad(pos.avgFixedAprWad)} />
                <Row label="Accrued net (unsettled)" value={<span data-testid="swap-accrued">{fmtAccrual(pos.netAccrued)}</span>} tone={toneOf(pos.netAccrued)} />
                <Row label="Value to maturity" value={formatSignedAusdWad(value)} tone={toneOf(value)} />
              </>
            );
          })()}
          {pos.size !== 0n && (
            <Button size="lg" block className="mt-2" disabled={!isConnected || tx.busy} onClick={close}>
              Close (reduce-only)
            </Button>
          )}
        </Card>
      )}

      </div>
      <Card title="Swap margin" className="h-fit">
        <Row label="Collateral" value={pos ? `${formatAusdWad(pos.collateralWad)} AUSD` : "—"} />
        <div className="mt-2 flex gap-2">
          <input aria-label="Swap collateral amount" inputMode="decimal" value={collat} onChange={(e) => setCollat(e.target.value)} className="num h-12 min-w-0 flex-1 rounded-control bg-card-2 px-3 text-sm" />
          <Button variant="brand" size="lg" disabled={!isConnected || !swapMarket || tx.busy} onClick={() => moveCollateral("deposit")}>
            Deposit
          </Button>
          <Button size="lg" disabled={!isConnected || !swapMarket || tx.busy} onClick={() => moveCollateral("withdraw")}>
            Withdraw
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">Swap margin is separate from the perp account (same AUSD units).</p>
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
