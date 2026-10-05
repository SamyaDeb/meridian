"use client";
import type { ReactNode } from "react";
import { useIndexerCandles, useMarket } from "@/data/hooks";
import { Card, Chip, NumberCell, Tooltip } from "@/components/ds";
import { formatAprWad, formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, formatSignedAprWad } from "@/lib/format";
import { stats24h } from "@/lib/market24h";
import { signGlyph } from "@/components/ds/logic";
import { useNow } from "@/lib/useNow";

function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const body = (
    <div className="min-w-0 shrink-0">
      <div className="whitespace-nowrap text-[11px] text-muted">{label}</div>
      <div className="num whitespace-nowrap text-sm">{children}</div>
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
  return (
    <Card as="section" aria-label="Market" className="p-3! sm:p-4!" bodyClassName="@container">
      <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:gap-6">
      <div className="flex items-end justify-between gap-3 @3xl:items-center @3xl:justify-start @3xl:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="whitespace-nowrap font-semibold text-text">{m?.symbol ?? "MON-PERP"}</span>
            <span className="whitespace-nowrap">· AUSD · cross margin</span>
            {m?.testMarket && <Chip tone="warn">test market</Chip>}
          </div>
          {/* same-metric text placeholder: the LCP element paints in the first frame */}
          <div className="text-2xl font-semibold sm:text-3xl" data-testid="mark-price">
            {m ? <NumberCell value={m.lastMarkPrice} format={(v) => formatPriceWad(v)} /> : <span className="num text-muted">—.——————</span>}
          </div>
        </div>
        <div className="text-right text-[11px] text-muted @3xl:hidden">
          <div className="num">Index {m ? formatPriceWad(m.lastIndexPrice) : "—"}</div>
          <div className="num">OI {m ? formatBaseWad(m.openInterestLongWad, 0) : "—"} MON</div>
        </div>
      </div>

      <div className="-mx-1 flex items-center gap-5 overflow-x-auto px-1 pb-1 @3xl:pb-0" tabIndex={0} aria-label="Market statistics">
        <span className="hidden @3xl:contents">
          <Stat label="Index" hint="Oracle index price">
            {m ? formatPriceWad(m.lastIndexPrice) : dash}
          </Stat>
        </span>
        <Stat label="24h change" hint={hint24}>
          {s ? <span className={s.change > 0n ? "text-long" : s.change < 0n ? "text-short" : ""}>{pct(s.changeWad)}</span> : dash}
        </Stat>
        <Stat label="24h high" hint={hint24}>
          {s ? formatPriceWad(s.high) : dash}
        </Stat>
        <Stat label="24h low" hint={hint24}>
          {s ? formatPriceWad(s.low) : dash}
        </Stat>
        <Stat label="24h volume" hint={hint24}>
          {s ? `${formatAusdWad(s.volumeQuoteWad)} AUSD` : dash}
        </Stat>
        <Stat label="Open interest" hint="Long / short open interest (MON)">
          {m ? (
            <>
              <span className="text-long">▲{formatBaseWad(m.openInterestLongWad, 0)}</span> / <span className="text-short">▼{formatBaseWad(m.openInterestShortWad, 0)}</span>
            </>
          ) : (
            dash
          )}
        </Stat>
        <Stat label="Funding APR, every block" hint="Positive: longs pay shorts. Settles every block (~300 ms).">
          {m ? (
            <span className="inline-flex items-baseline gap-2">
              <span className={fundTone}>{formatSignedAprWad(m.lastRateAprWad, 3)}</span>
              <span className="text-[11px] text-muted" data-testid="funding-next">
                next #{formatFixed(m.lastFundingBlock + 1n, 0, 0)}
              </span>
            </span>
          ) : (
            dash
          )}
        </Stat>
        <div className="flex shrink-0 items-center gap-1.5" aria-label="Realized funding APR">
          {(
            [
              ["1h", m?.realizedApr1hWad],
              ["8h", m?.realizedApr8hWad],
              ["24h", m?.realizedApr24hWad],
            ] as const
          ).map(([label, v]) => (
            <Chip key={label} tone={v === undefined ? "neutral" : "brand"} title={v === undefined ? `Not enough history for ${label} yet` : `Realized funding APR over ${label}`}>
              <span className="num">
                {label} {m && v !== undefined ? formatAprWad(v) : "—"}
              </span>
            </Chip>
          ))}
        </div>
      </div>
      </div>
    </Card>
  );
}
