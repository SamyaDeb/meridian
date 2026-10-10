"use client";
import type { ReactNode } from "react";
import { useMarket } from "@/data/hooks";
import { Card } from "@/components/ds";
import { formatAprWad, formatSignedAprWad } from "@/lib/format";
import { MfiCard } from "@/features/rates/MfiCard";
import { CrossVenueCard } from "@/features/rates/CrossVenueCard";
import { MarketsTable } from "@/features/market/MarketsTable";
import { MarketSwitcher } from "@/components/market/MarketSwitcher";
import { usePerpMarket } from "@/data/market";
import { PerplMonitorCard } from "@/features/rates/PerplMonitorCard";
import { AlertsCard, CrashReplayCard, MeridianRiskCards } from "@/features/rates/MeridianRiskCards";

function Kpi({ label, children, sub }: { label: string; children: ReactNode; sub?: string }) {
  return (
    <Card as="div" className="p-3! sm:p-4!">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 text-lg font-semibold">{children}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="px-1 pt-2 text-sm font-semibold text-muted">
        {title}
      </h2>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * Rates & Risk (K5): funding on both Monad perp venues, a monitor for any Perpl position (Perpl's own liquidation
 * rule), Meridian's own risk and a recorded crash, and the alerts bot. Real sources only: Meridian's contracts and
 * indexer, Perpl's exchange read onchain (/api/perpl/*) and its indexed events, the MFI service. A missing source is an
 * empty state that names it, never a simulated number.
 */
export default function RatesPage() {
  const { data: m } = useMarket();
  const pm = usePerpMarket();
  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">Rates &amp; Risk</h1>
          <MarketSwitcher />
        </div>
        <p className="text-xs text-muted">
          Funding on Meridian and Perpl side by side, how close any Perpl position is to liquidation, and Meridian&apos;s own {pm.symbol} risk.{!pm.primary && " The Meridian Funding Index and the cross-venue chart below are MON-PERP only."}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Meridian funding now (APR)" sub="per block">
          {m ? formatSignedAprWad(m.lastRateAprWad, 3) : "—"}
        </Kpi>
        <Kpi label="Realized 1h" sub="funding-rate oracle">
          {m?.realizedApr1hWad !== undefined ? formatAprWad(m.realizedApr1hWad) : "—"}
        </Kpi>
        <Kpi label="Realized 8h" sub="funding-rate oracle">
          {m?.realizedApr8hWad !== undefined ? formatAprWad(m.realizedApr8hWad) : "—"}
        </Kpi>
        <Kpi label="Realized 24h" sub="funding-rate oracle">
          {m?.realizedApr24hWad !== undefined ? formatAprWad(m.realizedApr24hWad) : "—"}
        </Kpi>
      </div>

      <MarketsTable title="Funding by market" />

      <Section id="rates-funding" title="Funding across venues">
        <CrossVenueCard />
        <div className="lg:col-span-2">
          <MfiCard />
        </div>
      </Section>

      <Section id="rates-perpl" title="Perpl position risk">
        <PerplMonitorCard />
      </Section>

      <Section id="rates-meridian" title="Meridian risk">
        <MeridianRiskCards />
        <CrashReplayCard />
        <AlertsCard />
      </Section>
    </div>
  );
}
