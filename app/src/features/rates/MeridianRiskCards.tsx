"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, EmptyState, Notice, Skeleton } from "@/components/ds";
import { INDEXER_CHAIN_ID, INDEXER_URL, useInsuranceFlows, useMarket, useRiskParams } from "@/data/hooks";
import { operatorAccounts } from "@/config/deployments";
import { formatAusdToken, formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, shortAddress } from "@/lib/format";
import { DEFAULT_MMR_WAD } from "@/lib/units";
import { readChain } from "@/lib/wagmi";
import { CRASH_RUNS } from "./crashReplay";
import { latestIfBalance, meridianRisk } from "./meridianRisk";
import { bpsPct } from "./perplView";

const FLOW_LABEL = { Funded: "Top-up", PenaltyIn: "Liquidation penalty in", CoveredByInsurance: "Bad debt: insurance fund", CoveredByFees: "Bad debt: protocol fees", Uncovered: "Bad debt: uncovered" } as const;

/** Meridian risk (K5 step 4): liquidation distance of users' positions, OI and skew, MM share, insurance fund. */
export function MeridianRiskCards() {
  const { data: m } = useMarket();
  const { data: risk } = useRiskParams();
  const market = m?.clearingHouse;
  const q = useQuery({
    queryKey: ["risk", INDEXER_URL, market],
    queryFn: async ({ signal }) => (await import("@/data/indexer/risk")).fetchRisk(INDEXER_URL!, market!, signal),
    enabled: INDEXER_URL !== undefined && market !== undefined,
    refetchInterval: 15_000,
    retry: 1,
  });
  const flows = useInsuranceFlows(100);
  const sum = q.data && m ? meridianRisk(q.data.positions, m.lastMarkPrice, risk?.mmr ?? DEFAULT_MMR_WAD, operatorAccounts(INDEXER_CHAIN_ID), { longWad: m.openInterestLongWad, shortWad: m.openInterestShortWad }) : undefined;
  const maxCount = sum ? Math.max(1, ...sum.histogram.map((r) => r.count)) : 1;
  const ifBal = flows.data ? latestIfBalance(flows.data) : undefined;
  const explorer = readChain().chain.blockExplorers?.default.url;
  const needIndexer = <EmptyState compact title="Needs the indexer" body="Read from the Meridian indexer, which isn't connected here." />;
  return (
    <>
      <Card title="Meridian: liquidation distance (users' open positions)">
        {INDEXER_URL === undefined ? (
          needIndexer
        ) : q.isError ? (
          <Notice tone="warn" title="Indexer unavailable">
            Retrying.
          </Notice>
        ) : !sum ? (
          <Skeleton className="h-40 w-full" label="Loading positions" />
        ) : sum.histogram.every((r) => r.count === 0) ? (
          <EmptyState compact title="No open user positions" body={sum.operatorPositions > 0 ? `${sum.operatorPositions} operator positions (MM, house flow, keepers) are not counted.` : undefined} />
        ) : (
          <ul className="space-y-1.5" aria-label="User positions by distance to liquidation">
            {sum.histogram.map((r) => (
              <li key={r.label} className="grid grid-cols-[110px_minmax(0,1fr)_88px] items-center gap-2 text-xs">
                <span className="text-muted">{r.label}</span>
                <span className="h-3 overflow-hidden rounded-full bg-card-2">
                  <span className={`block h-full rounded-full ${r.label.startsWith("≤ 2") || r.label.startsWith("≤ 5") ? "bg-short" : r.label.startsWith("never") ? "bg-long" : "bg-warn"}`} style={{ width: `${(r.count / maxCount) * 100}%` }} />
                </span>
                <span className="num text-right">
                  {r.count} · {formatBaseWad(r.sizeWad, 0)}
                </span>
              </li>
            ))}
            <li className="pt-1 text-[10px] text-muted">
              Mark move to the isolated liquidation price (funding ignored), count · MON. {sum.users} user accounts; {sum.operatorPositions} operator positions (MM, house flow, keepers) excluded. Test markets excluded.
            </li>
          </ul>
        )}
      </Card>

      <Card title="Meridian: open interest and skew">
        {!m ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <dl className="num grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Long OI</dt>
                <dd>{formatBaseWad(m.openInterestLongWad, 0)} MON</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Short OI</dt>
                <dd>{formatBaseWad(m.openInterestShortWad, 0)} MON</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Skew (long − short) / total</dt>
                <dd>{sum ? bpsPct(sum.skewBps) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Our market maker&apos;s share of OI</dt>
                <dd>{sum ? `${bpsPct(sum.mmShareBps)} (${formatBaseWad(sum.mmLongWad, 0)} long · ${formatBaseWad(sum.mmShortWad, 0)} short)` : INDEXER_URL ? "…" : "needs the indexer"}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[10px] text-muted">OI per side from the market at block {formatFixed(m.lastFundingBlock, 0, 0)}; MM accounts are listed in deployments/{INDEXER_CHAIN_ID}.json (mmAccounts) and disclosed, never counted as users.</p>
          </>
        )}
      </Card>

      <Card title="Meridian: insurance fund and bad-debt waterfall" className="lg:col-span-2">
        {INDEXER_URL === undefined ? (
          needIndexer
        ) : flows.isError ? (
          <Notice tone="warn" title="Indexer unavailable">
            Retrying.
          </Notice>
        ) : !flows.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <dl className="num mb-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Balance now</dt>
                <dd>{ifBal !== undefined ? `${formatAusdToken(ifBal)} AUSD` : q.data?.insurance ? `${formatAusdToken(q.data.insurance.fundedToken - q.data.insurance.coveredToken)} AUSD` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Funded (all time)</dt>
                <dd>{q.data?.insurance ? `${formatAusdToken(q.data.insurance.fundedToken)} AUSD` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Bad debt covered</dt>
                <dd>{q.data?.insurance ? `${formatAusdToken(q.data.insurance.coveredToken)} AUSD` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Waterfall steps</dt>
                <dd>{flows.data.length}</dd>
              </div>
            </dl>
            {flows.data.length === 0 ? (
              <EmptyState compact title="No waterfall steps yet" body="Order: insurance fund → protocol fees → uncovered, plus top-ups and liquidation penalties in." />
            ) : (
              <div className="max-h-64 overflow-auto rounded-control" tabIndex={0} aria-label="Insurance fund history">
                <table className="num w-full min-w-[460px] text-left text-xs">
                  <caption className="sr-only">Insurance fund waterfall, newest first</caption>
                  <thead className="sticky top-0 bg-card text-muted">
                    <tr>
                      <th scope="col" className="py-1 font-normal">Block</th>
                      <th scope="col" className="py-1 font-normal">Step</th>
                      <th scope="col" className="py-1 text-right font-normal">Amount</th>
                      <th scope="col" className="py-1 text-right font-normal">IF after</th>
                      <th scope="col" className="py-1 text-right font-normal">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...flows.data].reverse().slice(0, 30).map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="py-1">{formatFixed(s.block, 0, 0)}</td>
                        <td className={`py-1 ${s.flow === "Uncovered" ? "text-short" : ""}`}>{FLOW_LABEL[s.flow]}</td>
                        <td className="py-1 text-right">{s.direction === "Out" ? "−" : s.direction === "In" ? "+" : ""}{formatAusdWad(s.amountWad)}</td>
                        <td className="py-1 text-right">{formatAusdToken(s.balanceAfterToken)}</td>
                        <td className="py-1 text-right">
                          {explorer ? (
                            <a className="underline" href={`${explorer}/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                              {shortAddress(s.txHash)}
                            </a>
                          ) : (
                            shortAddress(s.txHash)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

/** Crash replay (K5 step 4): a recorded crash, block by block. Every run says what it is. */
export function CrashReplayCard() {
  const run = CRASH_RUNS[0];
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frames = run?.frames ?? [];
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setI((x) => (x + 1 < frames.length ? x + 1 : (setPlaying(false), x))), 400);
    return () => clearInterval(t);
  }, [playing, frames.length]);
  if (!run || frames.length === 0) return null;
  const f = frames[i]!;
  const f0 = frames[0]!;
  const ifDelta = f.ifBalanceToken - f0.ifBalanceToken;
  return (
    <Card title="Crash replay" className="lg:col-span-2" right={<span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">{run.label.split(":")[0]}</span>}>
      <p className="mb-2 text-[11px] text-muted">
        {run.label}. Recorded block by block by the CrashDemo script ({run.csv}): the index drops 15 % in one block, the keeper liquidates the trader in that block, the insurance fund takes its share of the penalty. A run on Monad testnet&apos;s demo market liquidated by the CRE keeper will be added here once it is recorded.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => (i + 1 >= frames.length ? (setI(0), setPlaying(true)) : setPlaying((p) => !p))}>
          {playing ? "Pause" : i + 1 >= frames.length ? "Replay" : "Play"}
        </Button>
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="sr-only">Block</span>
          <input type="range" min={0} max={frames.length - 1} value={i} onChange={(e) => (setPlaying(false), setI(Number(e.target.value)))} className="min-w-0 flex-1 accent-[var(--brand)]" aria-valuetext={`block ${f.block}`} />
        </label>
        <span className="num text-xs text-muted">
          block {formatFixed(f.block, 0, 0)} (+{f.offset})
        </span>
      </div>
      <dl className="num mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
        <div>
          <dt className="text-xs text-muted">Index</dt>
          <dd>{formatPriceWad(f.indexWad)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Mark</dt>
          <dd>{formatPriceWad(f.markWad)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Trader position</dt>
          <dd className={f.traderSizeWad === 0n && f0.traderSizeWad !== 0n ? "text-short" : ""}>{f.traderSizeWad === 0n ? (f.offset > 0 ? "liquidated" : "flat") : `${formatBaseWad(f.traderSizeWad, 0)} MON`}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Insurance fund</dt>
          <dd>
            {formatAusdToken(f.ifBalanceToken)} {ifDelta > 0n ? <span className="text-long">(+{formatAusdToken(ifDelta)})</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Vault NAV</dt>
          <dd>{formatAusdToken(f.vaultNavToken)}</dd>
        </div>
      </dl>
      {f.liquidatedHere && <Notice tone="danger" className="mt-2" title={`Liquidated at block ${formatFixed(f.block, 0, 0)}`}>The same block as the 15 % drop: the keeper saw the position liquidatable and closed it before the next block.</Notice>}
    </Card>
  );
}

/** Alerts (K5 step 5): what the bot does; links the public channel only when NEXT_PUBLIC_ALERTS_CHANNEL_URL is set. */
export function AlertsCard() {
  const url = process.env.NEXT_PUBLIC_ALERTS_CHANNEL_URL || undefined;
  return (
    <Card title="Alerts">
      <p className="text-xs text-muted">
        An open-source bot (keepers/alerts) watches a list of Perpl wallets with the same risk math as this page and pages Discord or Telegram when a position comes within a set distance of liquidation, or the Meridian − Perpl spread passes a set APR. One message per condition per cooldown, and a recovery message when it clears. You run it with your own watch list; it isn&apos;t a hosted subscription.
      </p>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand-soft underline">
          Public alerts channel
        </a>
      ) : null}
    </Card>
  );
}
