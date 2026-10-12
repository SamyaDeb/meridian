"use client";
import type { ReactNode } from "react";
import Image from "next/image";
import { useIndexerCandles, useMarket, useRiskParams } from "@/data/hooks";
import { Card, Chip, NumberCell, Tooltip } from "@/components/ds";
import { formatAprWad, formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, formatSignedAprWad } from "@/lib/format";
import { stats24h } from "@/lib/market24h";
import { WAD } from "@/lib/units";
import { signGlyph } from "@/components/ds/logic";
import { useNow } from "@/lib/useNow";
import { usePerpMarket, usePerpMarkets } from "@/data/market";
import { MarketSwitcher } from "./MarketSwitcher";

/** Long label on wide strips, short one on narrow strips (container width), so the stats stay on one line. */
const L = (long: string, short: string) => (
  <>
    <span className="@3xl:hidden">{short}</span>
    <span className="hidden @3xl:inline">{long}</span>
  </>
);

function Stat({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  const body = (
    <div className="min-w-0 shrink-0">
      <div className={`whitespace-nowrap text-xs text-muted ${hint ? "dotted" : ""}`}>{label}</div>
      <div className="num mt-0.5 whitespace-nowrap text-[13px]">{children}</div>
    </div>
  );
  return hint ? (
    <Tooltip content={hint} side="bottom">
      {body}
    </Tooltip>
  ) : (
    body
  );
}

const pct = (wad: bigint) => `${signGlyph(wad)}${formatFixed((wad < 0n ? -wad : wad) * 100n, 18, 2)}%`;

/**
 * Market strip (FRONTEND_TRADE_PLAN §6.1): mark (flashes on tick), index, 24h stats (indexer Candle1h only),
 * open interest, funding APR per block with the next funding block, realized 1h / 8h / 24h APR chips, TEST badge.
 */
export function MarketStrip() {
  const { data: m } = useMarket();
  const { data: risk } = useRiskParams();
  const pm = usePerpMarket();
  const { markets } = usePerpMarkets();
  const price = (v: bigint) => formatPriceWad(v, pm.tickSizeWad);
  const size = (v: bigint) => formatBaseWad(v, pm.sizeDp);
  const { data: c1h, isError: candlesError, fetchStatus } = useIndexerCandles("Candle1h", 30);
  const nowSec = BigInt(Math.floor(useNow(30_000) / 1_000));
  const s = c1h && nowSec > 0n ? stats24h(c1h, nowSec) : undefined;
  const noIndexer = fetchStatus === "idle" && !c1h;
  const dash = <span className="text-muted">—</span>;
  const hint24 = noIndexer
    ? "24h stats come from the indexer, which isn't connected"
    : candlesError
      ? "Indexer unavailable"
      : c1h && !s
        ? "No trades in the last 24 h"
        : s && s.fromSec > nowSec - 86_400n
          ? `History starts at ${new Date(Number(s.fromSec) * 1_000).toUTCString()}`
          : undefined;
  const fundTone = m && m.lastRateAprWad < 0n ? "text-short" : m && m.lastRateAprWad > 0n ? "text-long" : "";
  const maxLev = risk && risk.imr > 0n ? WAD / risk.imr : 5n;
  return (
    <Card as="section" aria-label="Market" className="flex h-full items-center px-3! py-2.5! lg:px-4!" bodyClassName="@container w-full">
      <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:gap-8">
        {/* market: logo, name, max leverage (Hyperliquid's "MON-USDC  5x") */}
        <div className="flex shrink-0 items-center gap-2.5">
          <Image src="/meridian-logo.png" alt="" width={22} height={22} />
          <span className="whitespace-nowrap text-xl tracking-tight" data-testid="market-symbol">
            {m?.symbol ?? pm.symbol}
          </span>
          <span className="num rounded-[4px] bg-brand-tint px-1.5 py-0.5 text-xs text-brand-soft">{maxLev.toString()}x</span>
          {/* K7: MON-PERP / ETH-PERP (hidden when the deployment has one market) */}
          {markets.length > 1 && <MarketSwitcher />}
          {m?.testMarket && <Chip tone="warn">test market</Chip>}
          {!pm.primary && pm.keeperFed && (
            <Tooltip content="Testnet market: the oracle is pushed by our keeper from Pyth (Hermes). Funding every block, its own book and margin; vault, swaps and the MFI stay on MON-PERP." side="bottom">
              <span data-testid="keeper-fed-chip">
                <Chip tone="warn">testnet</Chip>
              </span>
            </Tooltip>
          )}
        </div>

        <div className="-mx-1 flex flex-wrap items-center gap-x-7 gap-y-2 px-1 @2xl:flex-nowrap @2xl:overflow-x-auto @2xl:[scrollbar-width:none]" aria-label="Market statistics">
        <Stat label="Mark" hint="Mark price: the funding and liquidation reference">
          {/* same-metric text placeholder: the LCP element paints in the first frame */}
          <span data-testid="mark-price">{m ? <NumberCell value={m.lastMarkPrice} format={price} /> : <span className="text-muted">—.——————</span>}</span>
        </Stat>
        <Stat label="Oracle" hint="Oracle index price">
          {m ? price(m.lastIndexPrice) : dash}
        </Stat>
        <Stat label={L("24h Change", "24h")} hint={hint24}>
          {s ? <span className={s.change > 0n ? "text-long" : s.change < 0n ? "text-short" : ""}>{pct(s.changeWad)}</span> : dash}
        </Stat>
        <Stat label={L("24h Volume", "Vol 24h")} hint={hint24}>
          {s ? `${formatAusdWad(s.volumeQuoteWad)} AUSD` : dash}
        </Stat>
        <Stat label={L("Open Interest", "OI")} hint={`Long / short open interest (${pm.base})`}>
          {m ? (
            <>
              <span className="text-long">▲{size(m.openInterestLongWad)}</span> / <span className="text-short">▼{size(m.openInterestShortWad)}</span>
            </>
          ) : (
            dash
          )}
        </Stat>
        <Stat
          label={L("Funding APR / Block", "Funding APR")}
          hint={`Positive: longs pay shorts. Settles every block (~300 ms). Realized (funding-rate oracle): 1h ${m?.realizedApr1hWad !== undefined ? formatAprWad(m.realizedApr1hWad) : "—"} · 8h ${m?.realizedApr8hWad !== undefined ? formatAprWad(m.realizedApr8hWad) : "—"} · 24h ${m?.realizedApr24hWad !== undefined ? formatAprWad(m.realizedApr24hWad) : "—"}`}
        >
          {m ? (
            <span className="inline-flex items-baseline gap-2">
              <span className={fundTone}>{formatSignedAprWad(m.lastRateAprWad, 3)}</span>
              <span className="hidden text-[11px] text-muted 2xl:inline" data-testid="funding-next">
                next #{formatFixed(m.lastFundingBlock + 1n, 0, 0)}
              </span>
            </span>
          ) : (
            dash
          )}
        </Stat>
      </div>
      </div>
    </Card>
  );
}
