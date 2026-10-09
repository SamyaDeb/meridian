// Pro → Trades (research §5.3, N5 deliverable 3): recent public trades on both venues, newest first. Perpl from the
// market-data socket (`trades@<id>`, websocket.md "Trade Messages"), Meridian from the OrderBook `Trade` events. Each row:
// venue (dot + name), the taker's side in words + colour (never colour alone), price, size, block. Nothing invented:
// a venue with no trades yet says so.
import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { usePerpl, useMeridian } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState, TradeRow } from "../../live/perplMarket";
import { Store, useStore } from "../../live/store";
import { colors, dpOfTick, space, Text } from "../../ui";
import type { MeridianTradesState } from "./data/trades";
import { priceText, sizeText } from "./ticket/quote";
import { useTrade } from "./TradeProvider";

const ROWS = 20;
const selP = (s: PerplMarketState | undefined) => s?.trades;
const selPdp = (s: PerplMarketState | undefined) => s?.priceDecimals;
const selPsd = (s: PerplMarketState | undefined) => s?.sizeDecimals;
const selTick = (s: MeridianMarketState | undefined) => s?.tickSizeWad;
const selLot = (s: MeridianMarketState | undefined) => s?.lotSizeWad;
const NO_M = new Store<MeridianTradesState>({ rows: [], toBlock: undefined, error: undefined });
const selM = (s: MeridianTradesState) => s;
const NONE: readonly TradeRow[] = [];

/** Both venues' rows, newest block first (rows without a block go last), capped. */
export function mergeTrades(a: readonly TradeRow[], b: readonly TradeRow[], n = ROWS): TradeRow[] {
  return [...a, ...b].sort((x, y) => (y.block ?? -1) - (x.block ?? -1)).slice(0, n);
}

export const Trades = memo(function Trades() {
  const { trades: reader } = useTrade();
  const perpl = usePerpl(selP) ?? NONE;
  const pdp = usePerpl(selPdp);
  const psd = usePerpl(selPsd);
  const tick = useMeridian(selTick);
  const lot = useMeridian(selLot);
  const m = useStore(reader?.store ?? NO_M, selM);

  // read Meridian's trades only while this tab is mounted
  useEffect(() => {
    if (!reader) return;
    reader.active.set(true);
    return () => reader.active.set(false);
  }, [reader]);

  const rows = mergeTrades(perpl, m.rows);
  const dp = (r: TradeRow) => (r.venue === "perpl" ? (pdp ?? 5) : dpOfTick(tick));
  const step = (r: TradeRow) => (r.venue === "perpl" ? 10n ** BigInt(18 - (psd ?? 0)) : (lot ?? 10n ** 18n));

  return (
    <View style={s.wrap} testID="pro-trades">
      <View style={s.head} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {["Venue", "Side", "Price", "Size", "Block"].map((h) => (
          <Text key={h} variant="caption" tone="muted" style={h === "Venue" ? s.venue : s.col}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => {
        const price = priceText(r.priceWad, dp(r));
        const size = `${sizeText(r.sizeWad, step(r))} MON`;
        const side = r.side === "buy" ? "Buy" : "Sell";
        const name = r.venue === "perpl" ? "Perpl" : "Meridian";
        return (
          <View key={`${r.venue}-${r.txHash ?? ""}-${r.block ?? ""}-${i}`} style={s.row} accessible accessibilityLabel={`${name}: ${side} ${size} at ${price}${r.block !== undefined ? `, block ${r.block}` : ""}`} testID={`trade-row-${i}`}>
            <View style={[s.venue, s.name]}>
              <View style={[s.dot, r.venue === "meridian" ? { backgroundColor: colors.brand } : { borderWidth: 2, borderColor: colors.text }]} />
              <Text variant="caption">{name}</Text>
            </View>
            <Text variant="caption" tone={r.side === "buy" ? "long" : "short"} bold style={s.col}>
              {side}
            </Text>
            <Text variant="caption" style={[s.col, s.num]}>
              {price}
            </Text>
            <Text variant="caption" style={[s.col, s.num]}>
              {size}
            </Text>
            <Text variant="caption" tone="muted" style={[s.col, s.num]}>
              {r.block ?? "—"}
            </Text>
          </View>
        );
      })}
      {perpl.length === 0 ? (
        <Text variant="caption" tone="muted" testID="trades-none-perpl">
          Perpl: no trades received yet.
        </Text>
      ) : null}
      {m.rows.length === 0 ? (
        <Text variant="caption" tone="muted" testID="trades-none-meridian">
          {m.error ? `Meridian: couldn't read trades (${m.error}).` : m.toBlock === undefined ? "Meridian: reading recent trades…" : "Meridian: no trades in the last 100 blocks."}
        </Text>
      ) : null}
    </View>
  );
});

const s = StyleSheet.create({
  wrap: { gap: space.xs },
  head: { flexDirection: "row", gap: space.s },
  row: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: 28 },
  venue: { flex: 1.4 },
  name: { flexDirection: "row", alignItems: "center", gap: space.xs },
  col: { flex: 1, textAlign: "right" },
  num: { fontVariant: ["tabular-nums"] },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
