"use client";
import type { ReactNode } from "react";
import { useMarket } from "@/data/hooks";
import { PageHeader, StatCard } from "@/components/ds";
import { formatAprWad, formatSignedAprWad } from "@/lib/format";
import { MfiCard } from "@/features/rates/MfiCard";
import { CrossVenueCard } from "@/features/rates/CrossVenueCard";
import { MarketsTable } from "@/features/market/MarketsTable";
import { MarketSwitcher } from "@/components/market/MarketSwitcher";
import { usePerpMarket } from "@/data/market";
import { PerplMonitorCard } from "@/features/rates/PerplMonitorCard";
import { PerplSwapCard } from "@/features/rates/PerplSwapCard";
import { AlertsCard, CrashReplayCard, MeridianRiskCards } from "@/features/rates/MeridianRiskCards";

function Kpi({ label, children, sub }: { label: string; children: ReactNode; sub?: string }) {
  return <StatCard label={label} value={children} sub={sub && <span className="text-muted">{sub}</span>} />;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="px-1 pt-3 text-[15px] text-text">
        {title}
      </h2>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">{children}</div>
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
    <div className="space-y-3">
      <PageHeader
        title="Rates & Risk"
        description={
          <>
            Funding on Meridian and Perpl side by side, how close any Perpl position is to liquidation, and Meridian&apos;s own {pm.symbol} risk.{!pm.primary && " The Meridian Funding Index and the cross-venue chart below are MON-PERP only."}
          </>
        }
        actions={<MarketSwitcher />}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

      <Section id="rates-perpl-swap" title="Fix Perpl funding">
        <PerplSwapCard />
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
