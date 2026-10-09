// Trade header (research §5.3): MON price per block (Perpl mark, Meridian's when Perpl has none), 24 h change from the
// 1 h candles, both venues' funding APR, Perpl's next-funding countdown (Meridian funds every block). Each number is a
// leaf subscription, so a block tick re-renders only what changed.
import { formatDuration } from "@meridian/core/meridian";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useFundingSpread, useMeridian, usePerpl } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState } from "../../live/perplMarket";
import { Store, useStore } from "../../live/store";
import { BlockPulse, colors, Num, space, Text } from "../../ui";
import { change24hBps } from "./chart/series";
import type { ChartFeed, ChartState } from "./chart/feed";

const selPMark = (s: PerplMarketState | undefined) => s?.markWad;
const selPdp = (s: PerplMarketState | undefined) => s?.priceDecimals;
const selStale = (s: PerplMarketState | undefined) => s?.stale ?? false;
const selMMark = (s: MeridianMarketState | undefined) => s?.markWad;
const selDay = (s: ChartState) => s.day;
const selCountdown = (s: PerplMarketState | undefined) => s?.countdown?.secondsLeft;
const selDue = (s: PerplMarketState | undefined) => s?.countdown?.due ?? false;

const Price = memo(function Price() {
  const pm = usePerpl(selPMark);
  const mm = useMeridian(selMMark);
  const dp = usePerpl(selPdp);
  const stale = usePerpl(selStale);
  return <Num value={pm ?? mm} kind="price" dp={dp ?? 5} variant="hero" stale={stale} label="MON price" testID="trade-price" />;
});

const Change = memo(function Change({ chart }: { chart: ChartFeed | undefined }) {
  const day = useStore(chart?.store ?? EMPTY_CHART, selDay);
  const mark = usePerpl(selPMark);
  const bps = change24hBps(day, Date.now(), mark);
  // bps → WAD fraction (bps · 1e14) for the shared formatter (signed, coloured, "—" when unknown)
  return <Num value={bps === undefined ? undefined : bps * 10n ** 14n} kind="apr" signed label="24 hour change" testID="trade-change" />;
});

const Funding = memo(function Funding() {
  const f = useFundingSpread();
  const secs = usePerpl(selCountdown);
  const due = usePerpl(selDue);
  return (
    <View style={s.funding}>
      <View style={s.fcol}>
        <Text variant="caption" tone="muted">
          Meridian funding
        </Text>
        <Num value={f.meridianAprWad} kind="apr" signed invertTone label="Meridian funding APR" variant="caption" testID="trade-funding-meridian" />
        <Text variant="caption" tone="muted">
          every block
        </Text>
      </View>
      <View style={s.fcol}>
        <Text variant="caption" tone="muted">
          Perpl funding
        </Text>
        <Num value={f.perplAprWad} kind="apr" signed invertTone label="Perpl funding APR" variant="caption" testID="trade-funding-perpl" />
        <Text variant="caption" tone="muted" testID="trade-countdown">
          {secs === undefined ? "next in —" : due ? "next: settling now" : `next in ${formatDuration(Number(secs))}`}
        </Text>
      </View>
    </View>
  );
});

const EMPTY_CHART = new Store<ChartState>({ tf: "15m", points: [], day: [], loading: false, error: undefined });

export function TradeHeader({ chart }: { chart: ChartFeed | undefined }) {
  return (
    <View style={s.wrap}>
      <View style={s.top}>
        <Text variant="caption" tone="muted">
          MON perpetual
        </Text>
        <BlockPulse />
      </View>
      <View style={s.priceRow}>
        <Price />
        <Change chart={chart} />
      </View>
      <Funding />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: space.s },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: space.m, flexWrap: "wrap" },
  funding: { flexDirection: "row", gap: space.l, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: colors.border },
  fcol: { flex: 1, gap: 2, paddingTop: space.s },
});
