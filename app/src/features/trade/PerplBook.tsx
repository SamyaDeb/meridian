"use client";
// Read-only "Perpl" tab of the book card: Perpl's MON perp order book on Monad mainnet, another venue, shown for
// comparison only. Labelled with the venue on every render, greyed, and not clickable (nothing here can be traded on
// Meridian, and no level loads into the ticket). Never merged with Meridian's book. Off unless
// NEXT_PUBLIC_PERPL_REFERENCE=1.
import { useQuery } from "@tanstack/react-query";
import { Chip, EmptyState, Skeleton } from "@/components/ds";
import { PERPL_APP_URL, PERPL_VENUE, perplToDepth, type PerplBookPayload } from "@/features/chart/datafeed/perpl";
import { ladder, spread, totalSize, type LadderRow } from "@/lib/book";
import { formatBaseWad, formatFixed, formatPriceWad } from "@/lib/format";

export const PERPL_BOOK_LABEL = `${PERPL_VENUE} · read-only, can't be traded here`;
const LEVELS = 12; // per side on screen, as Meridian's book
const POLL_MS = 5_000;

function Row({ r, side }: { r: LadderRow; side: "bid" | "ask" }) {
  return (
    <li className="num relative grid h-6 grid-cols-3 items-center px-2 text-[11px]" aria-label={`Perpl ${side} ${formatPriceWad(r.priceWad)}, ${formatBaseWad(r.sizeWad, 0)} MON`}>
      <span className={`absolute inset-y-0 right-0 rounded-[6px] ${side === "bid" ? "bg-long/8" : "bg-short/8"}`} style={{ width: `${r.depthBps / 100}%` }} aria-hidden />
      <span className={`relative text-left ${side === "bid" ? "text-long/75" : "text-short/75"}`}>{formatPriceWad(r.priceWad)}</span>
      <span className="relative text-right text-text/75">{formatBaseWad(r.sizeWad, 0)}</span>
      <span className="relative text-right text-muted">{formatBaseWad(r.cumSizeWad, 0)}</span>
    </li>
  );
}

/** Pure view of one snapshot (rendered by tests without a network). */
export function PerplLadder({ payload }: { payload: PerplBookPayload }) {
  const d = perplToDepth(payload);
  const bids = d.bids.slice(0, LEVELS);
  const asks = d.asks.slice(0, LEVELS);
  const scale = totalSize(bids) > totalSize(asks) ? totalSize(bids) : totalSize(asks);
  const s = spread(d.bids[0]?.priceWad, d.asks[0]?.priceWad);
  const at = payload.timeMs > 0 ? `${new Date(payload.timeMs).toISOString().slice(11, 19)} UTC` : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="perpl-book">
      <div className="grid grid-cols-3 px-2 pb-1 text-[10px] text-muted">
        <span>Price</span>
        <span className="text-right">Size (MON)</span>
        <span className="text-right">Total</span>
      </div>
      {bids.length === 0 && asks.length === 0 ? (
        <EmptyState title="Perpl book empty" body="No resting orders on Perpl's MON market right now." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <ul aria-label="Perpl asks" className="flex flex-col-reverse">
            {ladder(asks, scale).map((r) => (
              <Row key={r.priceWad.toString()} r={r} side="ask" />
            ))}
          </ul>
          <div className="num my-1 flex items-center justify-between rounded-control bg-card-2 px-2 py-1 text-[11px]">
            <span className="text-muted">Perpl spread</span>
            <span>{s ? `${formatPriceWad(s.absWad)} · ${formatFixed(s.bps * 10n ** 16n, 18, 2)}%` : "—"}</span>
          </div>
          <ul aria-label="Perpl bids">
            {ladder(bids, scale).map((r) => (
              <Row key={r.priceWad.toString()} r={r} side="bid" />
            ))}
          </ul>
        </div>
      )}
      <p className="num mt-1 px-2 text-[10px] text-muted">
        Block #{payload.block.toLocaleString("en-US")}
        {at ? ` · ${at}` : ""} · via Perpl&apos;s public API ·{" "}
        <a href={PERPL_APP_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-text">
          perpl.xyz
        </a>
      </p>
    </div>
  );
}

export function PerplBook() {
  const q = useQuery({
    queryKey: ["perplBook"],
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/perpl/book", { signal });
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      return body as PerplBookPayload;
    },
    refetchInterval: POLL_MS,
    retry: 1,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2">
        <Chip tone="warn" dot className="!whitespace-normal">
          <span data-testid="perpl-book-label">{PERPL_BOOK_LABEL}</span>
        </Chip>
      </div>
      {q.isError ? (
        <EmptyState title="Perpl unavailable" body={`${q.error.message}. Nothing is shown rather than an old or made-up book.`} />
      ) : !q.data ? (
        <Skeleton className="h-64 w-full" label="Loading Perpl book" />
      ) : (
        <PerplLadder payload={q.data} />
      )}
    </div>
  );
}
