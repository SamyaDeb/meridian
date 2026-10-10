"use client";
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { fundingCostPerDayWad, lotsToMonInput, offsetOnMeridian } from "@meridian/risk";
import { Button, Card, Chip, EmptyState, Notice, PillTabs, Skeleton } from "@/components/ds";
import { aprPct, fmtPct } from "@/components/charts/model";
import { useDepth, useMarket, usePerplAccount } from "@/data/hooks";
import { MFI_URL, fetchMfiCurrent } from "@/data/mfi";
import { useQuery } from "@tanstack/react-query";
import { formatAusdWad, formatBaseWad, formatDuration, formatFixed, formatPriceWad, shortAddress } from "@/lib/format";
import { PERP_LOT_SIZE_WAD } from "@/lib/units";
import { setDraft } from "@/features/trade/draft";
import { PERPL_CHAIN_LABEL, type PerplChainId } from "./perplChain";
import { bpsPct, formatPerplPrice, leverageLabel, monitor, monitorHref, visibleBookLots, type MonitoredPosition } from "./perplView";

const CHAIN_TABS = [
  { id: "10143" as const, label: "Testnet" },
  { id: "143" as const, label: "Mainnet" },
];
const signedAusd = (w: bigint) => `${w < 0n ? "−" : w > 0n ? "+" : ""}${formatAusdWad(w < 0n ? -w : w)}`;

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <dt className="text-muted">{label}</dt>
      <dd className={`num text-right ${tone ?? ""}`}>{children}</dd>
    </div>
  );
}

const noSubscribe = () => () => {};
/** ?perpl=<address>&chain=<id> of the page URL ("" on the server: the static page renders the empty form). */
function useQueryString(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.search, () => "");
}
/** Pure: the monitor's shareable query → address and chain (an invalid address is kept for the input, not read). */
export function parseMonitorQuery(search: string): { address?: string; chain?: PerplChainId } {
  const sp = new URLSearchParams(search);
  const a = sp.get("perpl") ?? undefined;
  const c = Number(sp.get("chain"));
  return { ...(a ? { address: a } : {}), ...(c === 143 || c === 10143 ? { chain: c } : {}) };
}

/**
 * Perpl position monitor (K5 step 3): any wallet's Perpl positions, read onchain (/api/perpl/positions, getPositionV2
 * and friends), with Perpl's own liquidation rule, ±5/10/15 % shocks, funding cost per day at the Perpl rate and the
 * MFI, and a prefilled "Offset on Meridian" ticket (never submitted from here). Shareable: /rates?perpl=…&chain=….
 */
export function PerplMonitorCard() {
  const init = parseMonitorQuery(useQueryString());
  // what the user typed / picked wins; until then the shared link's values
  const [typed, setInput] = useState<string | undefined>();
  const [picked, setChain] = useState<PerplChainId | undefined>();
  const [submitted, setAddress] = useState<string | undefined>();
  const input = typed ?? init.address ?? "";
  const chain = picked ?? init.chain ?? 10143;
  const address = submitted ?? (init.address && isAddress(init.address, { strict: false }) ? getAddress(init.address) : undefined);
  const q = usePerplAccount(address, chain);
  const other: PerplChainId = chain === 143 ? 10143 : 143;
  const noAccount = q.data && q.data.account === null;
  const otherQ = usePerplAccount(noAccount ? address : undefined, other);
  const mfi = useQuery({ queryKey: ["mfi", MFI_URL], queryFn: ({ signal }) => fetchMfiCurrent(MFI_URL!, signal), enabled: MFI_URL !== undefined, refetchInterval: 30_000, retry: 1 });
  const valid = input === "" || isAddress(input.trim(), { strict: false });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = input.trim();
    if (!isAddress(a, { strict: false })) return;
    const cs = getAddress(a);
    setInput(cs);
    setAddress(cs);
    window.history.replaceState(null, "", monitorHref(cs, chain));
  };
  const pickChain = (c: PerplChainId) => {
    setChain(c);
    if (address) window.history.replaceState(null, "", monitorHref(address, c));
  };

  const positions = q.data ? monitor(q.data, mfi.data?.aprWad) : undefined;
  return (
    <Card title="Perpl position monitor" className="lg:col-span-2" right={<PillTabs size="sm" ariaLabel="Perpl network for the monitor" tabs={CHAIN_TABS} value={String(chain) as "10143" | "143"} onChange={(v) => pickChain(Number(v) as PerplChainId)} />}>
      <div id="perpl-monitor" className="scroll-mt-20" />
      <p className="mb-2 text-[11px] text-muted">
        Any Perpl wallet, read onchain from Perpl&apos;s exchange on {PERPL_CHAIN_LABEL[chain]}. Liquidation price with Perpl&apos;s own rule: entry + side · (maintenance − deposit − funding) / size. Read-only; nothing is signed here.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          <span className="text-muted">Perpl wallet address</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!valid}
            className={`num h-10 w-full min-w-0 rounded-control border bg-card-2 px-3 text-[13px] pointer-coarse:h-11 ${valid ? "border-border" : "border-short"}`}
          />
        </label>
        <Button type="submit" disabled={!valid || input.trim() === ""}>
          Monitor
        </Button>
      </form>
      {!valid && <p className="mt-1 text-[11px] text-short">Not an EVM address (0x + 40 hex characters).</p>}
      {address && (
        <p className="num mt-1 text-[11px] text-muted">
          <span className="break-all">{address}</span> · {PERPL_CHAIN_LABEL[chain]}
          {q.data?.account ? ` · Perpl account ${q.data.account.accountId}` : ""}
          {q.data ? ` · block ${formatFixed(BigInt(q.data.block), 0, 0)}` : ""}
          {q.data?.stale ? " · stale (RPC rate-limited, last good read)" : ""}
        </p>
      )}

      <div className="mt-3">
        {!address ? (
          <EmptyState compact title="Paste a Perpl wallet" body="Size, entry, margin, liquidation price and funding for every open Perpl position, with shocks and a one-tap offset on Meridian." />
        ) : q.isError ? (
          <Notice tone="warn" title="Perpl read unavailable">
            {(q.error as Error).message}. Retrying every few seconds.
          </Notice>
        ) : !q.data ? (
          <Skeleton className="h-48 w-full" label="Reading Perpl" />
        ) : q.data.account === null ? (
          otherQ.data?.account ? (
            <Notice tone="info" title={`No Perpl account on ${PERPL_CHAIN_LABEL[chain]}`} action={<Button size="sm" variant="secondary" onClick={() => pickChain(other)}>Show {PERPL_CHAIN_LABEL[other]}</Button>}>
              This wallet has Perpl account {otherQ.data.account.accountId} on {PERPL_CHAIN_LABEL[other]}.
            </Notice>
          ) : (
            <EmptyState compact title="No Perpl account" body={`${shortAddress(address)} has never created a Perpl account on ${PERPL_CHAIN_LABEL[chain]}${otherQ.isPending ? "" : ` or ${PERPL_CHAIN_LABEL[other]}`}.`} />
          )
        ) : positions!.length === 0 ? (
          <EmptyState compact title="No open positions" body={`Perpl account ${q.data.account.accountId} has nothing open on ${PERPL_CHAIN_LABEL[chain]}. Balance ${formatFixed(BigInt(q.data.account.balanceCNS), 6, 2)} AUSD.`} />
        ) : (
          <div className="space-y-3">
            {positions!.map((p) => (
              <PositionView key={p.perpId} p={p} />
            ))}
            {q.data.unknownPerps.length > 0 && <p className="text-[11px] text-muted">Also open on Perpl markets {q.data.unknownPerps.join(", ")}, which deployments/perpl.json doesn&apos;t describe: not shown rather than guessed.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

function PositionView({ p }: { p: MonitoredPosition }) {
  const r = p.risk;
  const pd = p.priceDecimals;
  const long = r.side === "Long";
  return (
    <div className="rounded-inner bg-card-2 p-3" data-testid="perpl-position">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip tone={long ? "long" : "short"}>{r.side}</Chip>
        <span className="num text-sm font-semibold">
          {formatBaseWad(r.sizeWad, 0)} {p.name}
        </span>
        <span className="text-[11px] text-muted">
          Perpl {p.name} perp {p.perpId} · {PERPL_CHAIN_LABEL[p.chainId]} · {leverageLabel(r.leverageWad)}
        </span>
        {!p.markValid && <Chip tone="warn">mark not valid onchain</Chip>}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-2 md:grid-cols-3">
        <dl>
          <Row label="Entry">{formatPerplPrice(r.entryWad, pd)}</Row>
          <Row label="Mark">{formatPerplPrice(r.markWad, pd)}</Row>
          <Row label="Liquidation price" tone="font-semibold text-warn">
            <span data-testid="perpl-liq">{formatPerplPrice(r.liqPriceWad, pd, long ? "up" : "down")}</span>
          </Row>
          <Row label="Distance to liquidation" tone={r.liqDistanceBps <= 500n ? "text-short" : ""}>
            {bpsPct(r.liqDistanceBps)}
          </Row>
          <Row label="Bankruptcy price">{formatPerplPrice(r.bankruptcyPriceWad, pd, long ? "up" : "down")}</Row>
        </dl>
        <dl>
          <Row label="Margin (deposit)">{formatAusdWad(r.depositWad)} AUSD</Row>
          <Row label="Unrealized PnL" tone={r.unrealizedPnlWad < 0n ? "text-short" : "text-long"}>
            {signedAusd(r.unrealizedPnlWad)} AUSD
          </Row>
          <Row label="of which funding">{signedAusd(r.premiumPnlWad)} AUSD</Row>
          <Row label="Equity">{formatAusdWad(r.equityWad)} AUSD</Row>
          <Row label={`Maintenance (${formatFixed(r.maintFractionWad * 100n, 18, 0)} % of entry notional)`}>{formatAusdWad(r.mmrWad)} AUSD</Row>
        </dl>
        <dl>
          <Row label="Perpl rate now">{fmtPct(aprPct(p.perplAprWad))} APR</Row>
          <Row label="Funding / day at Perpl rate" tone={p.fundingPerDayPerplWad > 0n ? "text-short" : "text-long"}>
            {p.fundingPerDayPerplWad > 0n ? "pays " : p.fundingPerDayPerplWad < 0n ? "earns " : ""}
            {formatAusdWad(p.fundingPerDayPerplWad < 0n ? -p.fundingPerDayPerplWad : p.fundingPerDayPerplWad)} AUSD
          </Row>
          <Row label="Funding / day at the MFI">
            {p.fundingPerDayMfiWad === undefined ? "MFI not connected" : `${p.fundingPerDayMfiWad > 0n ? "pays " : p.fundingPerDayMfiWad < 0n ? "earns " : ""}${formatAusdWad(p.fundingPerDayMfiWad < 0n ? -p.fundingPerDayMfiWad : p.fundingPerDayMfiWad)} AUSD`}
          </Row>
          <Row label="Next Perpl funding">{p.countdown.due ? "due now" : `${formatFixed(p.countdown.blocksLeft, 0, 0)} blocks · ${formatDuration(Number(p.countdown.secondsLeft))}`}</Row>
        </dl>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="num w-full text-left text-xs">
          <caption className="mb-1 text-left text-[11px] text-muted">Mark shocks (funding held at today&apos;s accrued value)</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-1 font-normal">Mark move</th>
              <th scope="col" className="py-1 text-right font-normal max-sm:hidden">Mark</th>
              <th scope="col" className="py-1 text-right font-normal">PnL</th>
              <th scope="col" className="py-1 text-right font-normal">Margin left</th>
              <th scope="col" className="py-1 text-right font-normal max-sm:hidden">Margin / notional</th>
              <th scope="col" className="py-1 text-right font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {p.shocks.map((s) => (
              <tr key={String(s.moveBps)} className="border-t border-border">
                <td className="py-1">{bpsPct(s.moveBps, 0).replace(/^(?!−)/, "+")}</td>
                <td className="py-1 text-right max-sm:hidden">{formatPerplPrice(s.markWad, pd)}</td>
                <td className={`py-1 text-right ${s.pnlWad < 0n ? "text-short" : "text-long"}`}>{signedAusd(s.pnlWad)}</td>
                <td className="py-1 text-right">{s.equityWad < 0n ? `−${formatAusdWad(-s.equityWad)}` : formatAusdWad(s.equityWad)}</td>
                <td className="py-1 text-right max-sm:hidden">{bpsPct(s.marginRatioBps)}</td>
                <td className={`py-1 text-right ${s.outcome === "ok" ? "text-muted" : "font-semibold text-short"}`}>{s.outcome === "ok" ? "open" : s.outcome === "liquidated" ? "liquidated" : "bankrupt (ADL)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OffsetOnMeridian p={p} />
    </div>
  );
}

/** Prefills Meridian's ticket on the opposite side (Meridian lots, clipped to the visible book) and opens /trade. */
function OffsetOnMeridian({ p }: { p: MonitoredPosition }) {
  const router = useRouter();
  const { data: m } = useMarket();
  const { data: book } = useDepth(32);
  const r = p.risk;
  const hitSide = r.side === "Long" ? book?.bids : book?.asks; // the offset is a short (hits bids) or a long (lifts asks)
  const o = offsetOnMeridian(r.side, r.sizeWad, PERP_LOT_SIZE_WAD, visibleBookLots(hitSide, PERP_LOT_SIZE_WAD));
  const mSide = r.side === "Long" ? "Short" : "Long";
  const meridianDay = m && o.lots > 0n ? fundingCostPerDayWad(mSide, o.sizeWad, m.lastMarkPrice, m.lastRateAprWad) : undefined;
  const perplDay = fundingCostPerDayWad(r.side, o.sizeWad, r.markWad, p.perplAprWad);
  const go = () => {
    setDraft({ side: o.side, kind: "market", sizeIn: lotsToMonInput(o.lots, PERP_LOT_SIZE_WAD) });
    router.push("/trade");
  };
  const fmtDay = (w: bigint) => `${w > 0n ? "pays" : w < 0n ? "earns" : "flat"} ${formatAusdWad(w < 0n ? -w : w)}`;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <div className="num text-[11px] text-muted">
        {o.lots === 0n ? (
          <>{o.wantedLots === 0n ? `Meridian's lot is ${formatBaseWad(PERP_LOT_SIZE_WAD, 0)} MON: this position is smaller than one lot.` : `Meridian's visible book has no ${r.side === "Long" ? "bids" : "asks"} right now, so an offset (${o.side} ${lotsToMonInput(o.wantedLots, PERP_LOT_SIZE_WAD)} MON) has nothing to fill against.`}</>
        ) : (
          <>
            Offset: {o.side} {lotsToMonInput(o.lots, PERP_LOT_SIZE_WAD)} MON on Meridian ({formatFixed(o.lots, 0, 0)} lots{o.clippedToBook ? `, clipped to the visible book from ${formatFixed(o.wantedLots, 0, 0)}` : ""}
            {m ? ` at mark ${formatPriceWad(m.lastMarkPrice)}` : ""}). Funding per day for this size: Meridian {meridianDay !== undefined ? fmtDay(meridianDay) : "—"} · Perpl {fmtDay(perplDay)} AUSD.
          </>
        )}
      </div>
      <Button size="sm" onClick={go} disabled={o.lots === 0n}>
        Offset on Meridian
      </Button>
    </div>
  );
}
