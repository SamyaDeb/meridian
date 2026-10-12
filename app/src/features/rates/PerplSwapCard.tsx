"use client";
import Link from "next/link";
import { perplAprFromPct100k } from "@meridian/risk";
import { Card, EmptyState, Skeleton } from "@/components/ds";
import { Row } from "@/components/ui";
import { swapMarketFor } from "@/config/deployments";
import { useAccountAddress, usePerplMarket, useSwap } from "@/data/hooks";
import { formatAprWad, formatSignedAprWad } from "@/lib/format";
import { READ_CHAIN_ID } from "@/lib/wagmi";
import { perplFixedVsFloating } from "./crossVenue";

/**
 * CR-017: the swap market that settles on Perpl's MON funding (testnet). Its fixed APR (the swap's mark) next to
 * Perpl's floating APR: the rate in force onchain now and the realized 8 h from the adapter's snapshots of Perpl's
 * funding sum. Fixed − floating = what paying fixed costs over receiving Perpl's floating, at today's rates.
 */
export function PerplSwapCard() {
  const ref = swapMarketFor(READ_CHAIN_ID, "perpl");
  const me = useAccountAddress();
  const { data: swap, isLoading } = useSwap(me, "perpl");
  const now = usePerplMarket(10143);
  const p = now.data;
  const floatingNow = p ? perplAprFromPct100k(p.fundingRatePct100k, p.fundingIntervalSec) : undefined;
  const v = perplFixedVsFloating(swap?.stats.markAprWad, floatingNow, swap?.stats.realizedApr8hWad);
  const right = (
    <Link href="/fix?source=perpl" className="text-xs text-brand-soft hover:underline">
      Trade on Fix
    </Link>
  );
  return (
    <Card title="Fixed vs floating on Perpl (testnet)" right={ref ? right : undefined} aria-label="Perpl funding swap">
      {!ref ? (
        <EmptyState compact title="No Perpl-funding swap market here" body="It runs on Monad testnet only." />
      ) : !swap && isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !swap ? (
        <EmptyState compact title="Perpl funding swaps" body="Shown when the app reads the chain (testnet build)." />
      ) : (
        <div data-testid="perpl-swap-card">
          <Row label="Fixed APR (swap mark, 30d)" value={formatAprWad(swap.stats.markAprWad)} />
          <Row label="Perpl floating now (onchain rate)" value={floatingNow === undefined ? "—" : formatSignedAprWad(floatingNow, 2)} />
          <Row label="Perpl realized 8h" value={swap.stats.realizedApr8hWad === undefined ? "—" : formatSignedAprWad(swap.stats.realizedApr8hWad, 2)} />
          <Row label="Fixed − floating now" value={v.spreadNowWad === undefined ? "—" : formatSignedAprWad(v.spreadNowWad, 2)} />
          <Row label="Fixed − realized 8h" value={v.spread8hWad === undefined ? "—" : formatSignedAprWad(v.spread8hWad, 2)} />
          <p className="mt-2 text-xs text-muted">
            Settles on Perpl&apos;s onchain funding, once per Perpl funding interval (~43 min). Testnet. It trusts Perpl&apos;s funding data.
          </p>
        </div>
      )}
    </Card>
  );
}
