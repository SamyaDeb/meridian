// Trade (MOBILE_PLAN N5, research §5.3): header (price per block, 24 h, both fundings, countdown) → chart (Lite: a
// sparkline; Pro: the native chart with mark / entry / liq lines, scrub + haptics, timeframes) → position cards →
// Pro: both books. Sticky Long / Short open the ticket sheet. Lite is the default; Pro is remembered (G3).
import { wadToFloatForDisplay } from "@meridian/core/util";
import { memo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { secureKv } from "../../auth/secureKv";
import { Screen } from "../../features/shell/Screen";
import { Books } from "../../features/trade/Books";
import { PriceChart } from "../../features/trade/chart/PriceChart";
import { TIMEFRAMES, type ChartState, type Timeframe } from "../../features/trade/chart/feed";
import type { AccountsState } from "../../features/trade/data/accounts";
import { PositionCards } from "../../features/trade/positions/PositionCards";
import { useTradeView } from "../../features/trade/prefs";
import { TicketSheet, type TicketRef } from "../../features/trade/ticket/TicketSheet";
import { TradeHeader } from "../../features/trade/TradeHeader";
import { useAccountReadsWhileFocused, useTrade } from "../../features/trade/TradeProvider";
import { usePerpl } from "../../live/hooks";
import type { PerplMarketState } from "../../live/perplMarket";
import { Store, useStore } from "../../live/store";
import { Button, Card, colors, HIT, Segmented, space, Sparkline, Text } from "../../ui";

const selChart = (s: ChartState) => s;
const selAcc = (s: AccountsState) => s;
const selMark = (s: PerplMarketState | undefined) => s?.markWad;
const selPdp = (s: PerplMarketState | undefined) => s?.priceDecimals ?? 5;
const NO_CHART = new Store<ChartState>({ tf: "15m", points: [], day: [], loading: false, error: undefined });
const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });

const LiteChart = memo(function LiteChart() {
  const { chart } = useTrade();
  const c = useStore(chart?.store ?? NO_CHART, selChart);
  const pts = c.points.slice(-60).map((p) => wadToFloatForDisplay(p.priceWad));
  return <Sparkline points={pts} height={64} zeroLine={false} label={pts.length ? "MON price, last hour" : "MON price loading"} />;
});

const ProChart = memo(function ProChart() {
  const { chart, accounts } = useTrade();
  const c = useStore(chart?.store ?? NO_CHART, selChart);
  const acc = useStore(accounts?.store ?? NO_ACC, selAcc);
  const mark = usePerpl(selMark);
  const dp = usePerpl(selPdp);
  // entry / liq lines: the Perpl position (the chart is Perpl's price); else Meridian's
  const pp = acc.perpl?.position;
  const mp = acc.meridian && acc.meridian.sizeWad !== 0n ? acc.meridian : undefined;
  const entry = pp?.entryWad ?? mp?.entryWad;
  const liq = pp ? (pp.liqPriceWad > 0n ? pp.liqPriceWad : undefined) : mp && mp.liqWad > 0n ? mp.liqWad : undefined;
  const res = TIMEFRAMES.find((t) => t.key === c.tf)!.sec;
  return (
    <View style={s.gap}>
      <PriceChart points={c.points} lines={{ mark, entry, liq }} priceDp={dp} resSec={res} testID="pro-chart" />
      {c.error ? (
        <Text variant="caption" tone="warn">
          Chart: {c.error}
        </Text>
      ) : null}
      <View style={s.chips} accessibilityRole="tablist" accessibilityLabel="Chart timeframe">
        {TIMEFRAMES.map((t) => (
          <Button key={t.key} title={t.key} variant={t.key === c.tf ? "secondary" : "ghost"} onPress={() => chart?.setTimeframe(t.key as Timeframe)} accessibilityState={{ selected: t.key === c.tf }} style={s.chip} testID={`tf-${t.key}`} />
        ))}
      </View>
    </View>
  );
});

export default function Trade() {
  const ticket = useRef<TicketRef>(null);
  const { chart } = useTrade();
  const [view, setView] = useTradeView(secureKv);

  // positions / collateral are read per block only while this screen is on top
  useAccountReadsWhileFocused();

  return (
    <Screen
      footer={
        <View style={s.footer}>
          <Button title="Long" onPress={() => ticket.current?.open("long")} style={[s.side, { backgroundColor: colors.long }]} accessibilityHint="Opens the ticket to buy" testID="btn-long" />
          <Button title="Short" onPress={() => ticket.current?.open("short")} style={[s.side, { backgroundColor: colors.short }]} accessibilityHint="Opens the ticket to sell" testID="btn-short" />
        </View>
      }
    >
      <View style={s.titleRow}>
        <Text variant="title" accessibilityRole="header">
          Trade
        </Text>
        <View style={s.toggle}>
          <Segmented
            options={[
              { value: "lite", label: "Lite" },
              { value: "pro", label: "Pro" },
            ]}
            value={view}
            onChange={setView}
            accessibilityLabel="Lite or Pro view"
          />
        </View>
      </View>
      <Card>
        <TradeHeader chart={chart} />
        {view === "pro" ? <ProChart /> : <LiteChart />}
      </Card>
      <PositionCards />
      {view === "pro" ? (
        <Card>
          <Text variant="caption" tone="muted">
            Books
          </Text>
          <Books />
        </Card>
      ) : null}
      <TicketSheet ref={ticket} />
    </Screen>
  );
}

const s = StyleSheet.create({
  gap: { gap: space.s },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m },
  toggle: { width: 160 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: HIT, paddingHorizontal: space.m },
  footer: { flexDirection: "row", gap: space.m },
  side: { flex: 1 },
});
