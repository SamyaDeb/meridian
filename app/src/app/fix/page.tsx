"use client";
import { useEffect, useState } from "react";
import { useAccountAddress, useMarket, useSwap } from "@/data/hooks";
import { Card, Row, Skeleton, toneOf } from "@/components/ui";
import { formatAprWad, formatDuration, formatSignedAusdWad } from "@/lib/format";
import { swapPositionValueWad } from "@/lib/math";

export default function FixPage() {
  const me = useAccountAddress();
  const { data: m } = useMarket();
  const { data: swap } = useSwap(me);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const tau = swap ? Math.max(0, swap.info.maturityTimestamp - now) : 0;
  const maturity = swap ? new Date(swap.info.maturityTimestamp * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Fix your funding</h1>
      <Card>
        {!swap || !m ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted">Fixed (market)</div>
                <div className="num text-2xl font-semibold">{formatAprWad(swap.stats.markAprWad)}</div>
                <div className="text-[11px] text-muted">until {maturity}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Realized funding 8h</div>
                <div className="num text-2xl font-semibold">{swap.stats.realizedApr8hWad === undefined ? "—" : formatAprWad(swap.stats.realizedApr8hWad)}</div>
                <div className="text-[11px] text-muted">from the funding-rate oracle</div>
              </div>
            </div>
            <div className="mt-3 border-t border-border pt-2">
              <Row label="Matures in" value={swap.stats.matured ? "Matured" : formatDuration(tau)} />
              <Row label="Open interest" value={`${(Number(swap.stats.openInterestWad) / 1e24).toFixed(1)}M MON`} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" disabled className="h-12 rounded-xl bg-long/80 text-sm font-semibold text-bg opacity-60">
                Pay fixed {formatAprWad(swap.stats.markAprWad)}
              </button>
              <button type="button" disabled className="h-12 rounded-xl bg-short/80 text-sm font-semibold text-bg opacity-60">
                Receive fixed {formatAprWad(swap.stats.markAprWad)}
              </button>
            </div>
          </>
        )}
      </Card>

      {swap?.positions.map((s) => {
        const value = m ? swapPositionValueWad(s.size, s.fixedAprNotional, swap.stats.markAprWad, m.lastIndexPrice, BigInt(tau)) : 0n;
        return (
          <Card key={s.id} title="Your swap">
            {s.lockedSpread ? (
              // q = 0, K ≠ 0: a locked spread, not zero (MATH_SPEC §6.2)
              <p className="num text-lg font-semibold text-long">Locked {formatSignedAusdWad(value)} AUSD until {maturity}</p>
            ) : (
              <>
                <Row label="Your fixed APR" value={s.avgFixedAprWad === undefined ? "—" : formatAprWad(s.avgFixedAprWad)} />
                <Row label="Accrued net" value={formatSignedAusdWad(s.netAccrued)} tone={toneOf(s.netAccrued)} />
                <Row label="Value to maturity" value={formatSignedAusdWad(value)} tone={toneOf(value)} />
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}
