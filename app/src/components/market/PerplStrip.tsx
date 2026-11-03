"use client";
// Market strip while the terminal shows Perpl's MON perp (venue = perpl): another venue's live numbers, read through our
// cached Perpl routes (the same candles + book the chart and book card draw), labelled view-only. Nothing here is
// Meridian's mark, index, OI or funding.
import { useQuery } from "@tanstack/react-query";
import { Card, Chip } from "@/components/ds";
import { perplToDepth, scaledToWad, type PerplBookPayload, type PerplCandlesPayload } from "@/features/chart/datafeed/perpl";
import { spread } from "@/lib/book";
import { formatFixed, formatPriceWad } from "@/lib/format";
import { signGlyph } from "@/components/ds/logic";
import { useNow } from "@/lib/useNow";
import { MarketMenu } from "./MarketMenu";

const DAY_MS = 86_400_000;

async function getRoute<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal });
  const body: unknown = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return body as T;
}

/** Pure: last price and the trailing-24h open / high / low from hourly candles (WAD), or undefined without candles. */
export function perplDayStats(p: PerplCandlesPayload, nowMs: number) {
  const rows = [...p.d].sort((a, b) => a.t - b.t);
  const last = rows[rows.length - 1];
  if (!last) return undefined;
  const day = rows.filter((r) => r.t >= nowMs - DAY_MS);
  const w = (x: number) => scaledToWad(x, p.market.priceDecimals);
  const first = day[0] ?? last;
  return {
    last: w(last.c),
    open: w(first.o),
    high: w(Math.max(...(day.length ? day : [last]).map((r) => r.h))),
    low: w(Math.min(...(day.length ? day : [last]).map((r) => r.l))),
  };
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 shrink-0">
      <div className="whitespace-nowrap text-xs text-muted">{label}</div>
      <div className="num mt-0.5 whitespace-nowrap text-[13px]">{children}</div>
    </div>
  );
}

export function PerplStrip() {
  const now = useNow(30_000);
  const candles = useQuery({
    queryKey: ["perplCandles1h"],
    queryFn: ({ signal }) => getRoute<PerplCandlesPayload>("/api/perpl/candles?res=3600", signal),
    refetchInterval: 30_000,
    retry: 1,
  });
  const book = useQuery({
    queryKey: ["perplBook"],
    queryFn: ({ signal }) => getRoute<PerplBookPayload>("/api/perpl/book", signal),
    refetchInterval: 5_000,
    retry: 1,
  });
  const s = candles.data && now > 0 ? perplDayStats(candles.data, now) : undefined;
  const d = book.data ? perplToDepth(book.data) : undefined;
  const sp = spread(d?.bids[0]?.priceWad, d?.asks[0]?.priceWad);
  const chg = s && s.open > 0n ? ((s.last - s.open) * 10n ** 18n) / s.open : undefined;
  const dash = <span className="text-muted">—</span>;
  return (
    <Card as="section" aria-label="Market" className="flex h-full items-center px-3! py-2.5! lg:px-4!" bodyClassName="@container w-full">
      <div data-testid="perpl-strip" className="flex flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:gap-8">
        <div className="flex shrink-0 items-center gap-2.5">
          <MarketMenu symbol="MON-PERP" />
          <span data-testid="perpl-venue-chip">
            <Chip tone="warn">Perpl · Monad mainnet · view only</Chip>
          </span>
        </div>
        <div className="-mx-1 flex flex-wrap items-center gap-x-7 gap-y-2 px-1 @2xl:flex-nowrap @2xl:overflow-x-auto @2xl:[scrollbar-width:none]" aria-label="Perpl market statistics">
          <Stat label="Last">{s ? formatPriceWad(s.last) : dash}</Stat>
          <Stat label="24h Change">{chg !== undefined ? <span className={chg > 0n ? "text-long" : chg < 0n ? "text-short" : ""}>{`${signGlyph(chg)}${formatFixed((chg < 0n ? -chg : chg) * 100n, 18, 2)}%`}</span> : dash}</Stat>
          <Stat label="24h High">{s ? formatPriceWad(s.high) : dash}</Stat>
          <Stat label="24h Low">{s ? formatPriceWad(s.low) : dash}</Stat>
          <Stat label="Spread">{sp ? `${formatFixed(sp.bps * 10n ** 16n, 18, 3)}%` : dash}</Stat>
        </div>
      </div>
    </Card>
  );
}
