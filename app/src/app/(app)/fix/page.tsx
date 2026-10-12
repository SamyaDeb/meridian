"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { useAccountAddress, useMarket, useSwap } from "@/data/hooks";
import { Row, toneOf } from "@/components/ui";
import { Button, Card, Chip, Dialog, EmptyState, Notice, PageHeader, Skeleton, StatCard, Tooltip } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import { orderBookAbi } from "@/lib/abi";
import { closeOrder, marketLimitTick, swapAprToTick, swapTickToAprWad } from "@/lib/earnfix";
import { formatAprWad, formatAusdWad, formatBaseWad, formatDuration, formatFixed, formatSignedAusdWad, parseFixed } from "@/lib/format";

/** Per-block accrual on small notionals is ~1e-8 AUSD: show 8 dp so it visibly ticks. */
const fmtAccrual = (wad: bigint): string => `${wad < 0n ? "−" : wad > 0n ? "+" : ""}${formatFixed(wad < 0n ? -wad : wad, 18, 8)}`;
import { swapPositionValueWad } from "@/lib/math";
import { sendTx, swapDeposit, swapWithdraw } from "@/lib/tx";
import { READ_CHAIN_ID } from "@/lib/wagmi";

const SWAP_TICK = 10n ** 14n; // 1 bp APR (WS-05 deploy wiring)
const SWAP_LOT_MON = 1_000n; // 1 lot = 1,000 MON notional
const SWAP_LOT_WAD = SWAP_LOT_MON * 10n ** 18n;
const SLIPPAGE_TICKS = 20; // market orders take up to 20 bps APR beyond the best level

/** Best bid/ask ticks of the swap book (contract view getDepth). */
function useSwapBook(orderBook: `0x${string}` | undefined) {
  // the read chain, not the wallet's: the book must show before login (a logged-out wallet reports another chain)
  const pub = usePublicClient({ chainId: READ_CHAIN_ID });
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
  const swapBook = contractAddress(READ_CHAIN_ID, "SwapOrderBook");
  const ausd = contractAddress(chainId, "AUSD");
  const { data: book } = useSwapBook(swapBook);
  const [lots, setLots] = useState("2");
  const [limitApr, setLimitApr] = useState("");
  const [collat, setCollat] = useState("100");
  const [margin, setMargin] = useState<"deposit" | "withdraw" | null>(null);
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
    }, { opens: true });
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

  const bid = book?.bestBid ? formatAprWad(swapTickToAprWad(book.bestBid, SWAP_TICK)) : "—";
  const ask = book?.bestAsk ? formatAprWad(swapTickToAprWad(book.bestAsk, SWAP_TICK)) : "—";
  const th = "pb-2 pr-4 text-left text-xs font-normal text-muted";
  const td = "py-2 pr-4 text-[13px]";
  const input = "num h-10 w-full rounded-control border border-line bg-card-2 px-3 text-sm outline-none focus:border-brand-soft pointer-coarse:h-11";
  const hasPos = Boolean(pos && (pos.size !== 0n || pos.fixedAprNotional !== 0n));
  const value = hasPos && m && swap && pos ? swapPositionValueWad(pos.size, pos.fixedAprNotional, swap.stats.markAprWad, m.lastIndexPrice, BigInt(tau)) : 0n;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Fix"
        description="Funding swaps trade the per-block floating funding rate for a fixed APR until maturity. Pay fixed to turn a long perp's funding into a known cost; receive fixed to lock the carry. Swap margin is separate from the perp account."
        actions={
          <>
            <Button variant="brand" className="min-w-36" disabled={!isConnected || !swapMarket} onClick={() => setMargin("deposit")}>
              Deposit Margin
            </Button>
            <Button variant="outline" className="min-w-36" disabled={!isConnected || !swapMarket} onClick={() => setMargin("withdraw")}>
              Withdraw Margin
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={
            <Tooltip content="The swap book's mark: the fixed APR the market is trading at now.">
              <span className="dotted">Fixed APR (market)</span>
            </Tooltip>
          }
          right={swap ? <Chip tone={matured ? "warn" : "brand"}>{matured ? "matured" : "open"}</Chip> : undefined}
          value={swap ? <span data-testid="swap-mark-apr">{formatAprWad(swap.stats.markAprWad)}</span> : <Skeleton className="h-9 w-28" />}
          sub={<span className="text-muted">{maturity ? `until ${maturity}` : "—"}</span>}
        />
        <StatCard
          label={
            <Tooltip content="Realized MON-PERP funding over the last 8 hours, read from the funding-rate oracle.">
              <span className="dotted">Floating Funding 8h</span>
            </Tooltip>
          }
          value={swap?.stats.realizedApr8hWad === undefined ? "--" : formatAprWad(swap.stats.realizedApr8hWad)}
          sub={<span className="text-muted">from the funding-rate oracle</span>}
        />
        <StatCard label="Matures In" value={!swap ? "--" : matured ? "Matured" : formatDuration(tau)} sub={<span className="text-muted">{matured ? "close and withdraw only" : "one maturity, 30 days"}</span>} />
        <StatCard label="Your Swap Margin" value={pos ? `$${formatAusdWad(pos.collateralWad)}` : "$0.00"} sub={<span className="text-muted">AUSD, separate from perps</span>} />
      </div>

      {tx.status && (
        <Notice tone={tx.status.includes("failed") ? "danger" : "info"}>
          <span className="num break-all" data-testid="tx-status">
            {tx.status}
          </span>
        </Notice>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <Card title="Swap Market">
            {!swap || !m ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className={th}>Market</th>
                      <th className={th}>Best Bid (receive fixed)</th>
                      <th className={th}>Best Ask (pay fixed)</th>
                      <th className={th}>Mark</th>
                      <th className={th}>Open Interest</th>
                      <th className={th}>Maturity</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    <tr>
                      <td className={`${td} font-medium text-brand-soft`}>MON funding · 30d</td>
                      <td className={`${td} text-long`}>{bid}</td>
                      <td className={`${td} text-short`}>{ask}</td>
                      <td className={td}>{formatAprWad(swap.stats.markAprWad)}</td>
                      <td className={td}>{formatBaseWad(swap.stats.openInterestWad, 0)} MON</td>
                      <td className={td}>{matured ? <span className="text-warn">Matured</span> : maturity}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Your Swap" right={hasPos && pos && pos.size !== 0n ? <Button size="sm" variant="outline" disabled={!isConnected || tx.busy} onClick={close}>Close (reduce-only)</Button> : undefined}>
            {!hasPos || !pos ? (
              <EmptyState compact title="No open swap" body={isConnected ? "Pay or receive fixed from the ticket." : "Connect a wallet to see your swap."} />
            ) : pos.lockedSpread ? (
              // q = 0, K ≠ 0: a locked spread, not zero (MATH_SPEC §6.2)
              <p className="num text-lg text-long">
                Locked {formatSignedAusdWad(value)} AUSD until {maturity}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className={th}>Side</th>
                      <th className={th}>Size</th>
                      <th className={th}>Your Fixed APR</th>
                      <th className={th}>
                        <Tooltip content="Floating minus fixed, accrued every block and not yet settled.">
                          <span className="dotted">Accrued (unsettled)</span>
                        </Tooltip>
                      </th>
                      <th className={th}>Value to Maturity</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    <tr>
                      <td className={`${td} ${pos.size > 0n ? "text-long" : "text-short"}`}>{pos.size > 0n ? "Pay fixed" : "Receive fixed"}</td>
                      <td className={td}>{formatBaseWad(pos.size < 0n ? -pos.size : pos.size, 0)} MON</td>
                      <td className={td}>{pos.avgFixedAprWad === undefined ? "—" : formatAprWad(pos.avgFixedAprWad)}</td>
                      <td className={`${td} ${toneOf(pos.netAccrued) === "long" ? "text-long" : toneOf(pos.netAccrued) === "short" ? "text-short" : ""}`}>
                        <span data-testid="swap-accrued">{fmtAccrual(pos.netAccrued)}</span>
                      </td>
                      <td className={`${td} ${toneOf(value) === "long" ? "text-long" : toneOf(value) === "short" ? "text-short" : ""}`}>{formatSignedAusdWad(value)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card title="Trade Funding" className="h-fit" aria-label="Swap ticket">
          <label htmlFor="swap-lots" className="text-xs text-muted">
            Size (lots of {SWAP_LOT_MON.toString()} MON)
          </label>
          <input id="swap-lots" inputMode="numeric" value={lots} onChange={(e) => setLots(e.target.value)} className={`${input} mt-1`} />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="long" size="lg" disabled={!isConnected || matured || tx.busy || !book?.bestAsk} onClick={() => order(true, "market")}>
              Pay fixed {book?.bestAsk ? ask : ""}
            </Button>
            <Button variant="short" size="lg" disabled={!isConnected || matured || tx.busy || !book?.bestBid} onClick={() => order(false, "market")}>
              Receive fixed {book?.bestBid ? bid : ""}
            </Button>
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <label htmlFor="swap-limit" className="text-xs text-muted">
              Limit fixed APR (%)
            </label>
            <input id="swap-limit" aria-label="Limit fixed APR (%)" inputMode="decimal" placeholder="e.g. 12.5" value={limitApr} onChange={(e) => setLimitApr(e.target.value)} className={`${input} mt-1`} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="outline" disabled={!isConnected || matured || tx.busy} onClick={() => order(true, "limit")}>
                Bid
              </Button>
              <Button variant="outline" disabled={!isConnected || matured || tx.busy} onClick={() => order(false, "limit")}>
                Offer
              </Button>
            </div>
          </div>
          <div className="mt-4 border-t border-border pt-2">
            <Row label="Book (bid / ask)" value={`${bid} / ${ask}`} />
            <Row label="Matures in" value={matured ? "Matured" : formatDuration(tau)} tone={matured ? "warn" : undefined} />
          </div>
          <p className="mt-2 text-xs text-muted">Pay fixed = receive the floating MON-PERP funding: a long perp&apos;s funding cost becomes fixed.</p>
        </Card>
      </div>

      <Dialog open={margin !== null} onClose={() => setMargin(null)} title={margin === "withdraw" ? "Withdraw swap margin" : "Deposit swap margin"}>
        <Row label="Current margin" value={pos ? `${formatAusdWad(pos.collateralWad)} AUSD` : "—"} />
        <label htmlFor="swap-collat" className="mt-2 block text-xs text-muted">
          Amount (AUSD)
        </label>
        <input id="swap-collat" data-autofocus aria-label="Swap collateral amount" inputMode="decimal" value={collat} onChange={(e) => setCollat(e.target.value)} className={`${input} mt-1`} />
        <Button variant="brand" size="lg" block className="mt-4" disabled={!isConnected || !swapMarket || tx.busy} loading={tx.busy} onClick={() => moveCollateral(margin ?? "deposit")}>
          {margin === "withdraw" ? "Withdraw" : "Deposit"}
        </Button>
      </Dialog>
    </div>
  );
}
