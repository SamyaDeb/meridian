// Live mark + best bid / ask of both venues (Trade / Earn / Portfolio headers, route modal). Leaf components: a
// block tick re-renders only the rows whose numbers changed.
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useLiveness, useMeridian, usePerpl } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState } from "../../live/perplMarket";
import { BlockPulse, Card, colors, dpOfTick, Num, space, Text } from "../../ui";

type Quote = { mark: bigint | undefined; bid: bigint | undefined; ask: bigint | undefined; bookKnown: boolean; dp: number; stale: boolean; error: string | undefined };

const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;

function VenueRow({ name, q, accent }: { name: string; q: Quote; accent: boolean }) {
  const empty = q.bookKnown && q.bid === undefined && q.ask === undefined;
  return (
    <View style={s.venue}>
      <View style={s.nameRow}>
        <View style={[s.swatch, { backgroundColor: accent ? colors.brand : colors.text }]} />
        <Text bold>{name}</Text>
      </View>
      <View style={s.cols}>
        <View style={s.col}>
          <Text variant="caption" tone="muted">
            Mark
          </Text>
          <Num value={q.mark} kind="price" dp={q.dp} stale={q.stale} label={`${name} mark price`} />
        </View>
        {empty ? (
          <View style={[s.col, { flex: 2 }]}>
            <Text variant="caption" tone="muted">
              Book
            </Text>
            <Text tone="muted">No liquidity right now</Text>
          </View>
        ) : (
          <>
            <View style={s.col}>
              <Text variant="caption" tone="muted">
                Best bid
              </Text>
              <Num value={q.bid} kind="price" dp={q.dp} stale={q.stale} label={`${name} best bid`} tone="long" />
            </View>
            <View style={s.col}>
              <Text variant="caption" tone="muted">
                Best ask
              </Text>
              <Num value={q.ask} kind="price" dp={q.dp} stale={q.stale} label={`${name} best ask`} tone="short" />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const MeridianRow = memo(function MeridianRow() {
  const m = useMeridian(selM);
  const live = useLiveness();
  const q: Quote = { mark: m?.markWad, bid: m?.bestBidWad, ask: m?.bestAskWad, bookKnown: m?.bookKnown ?? false, dp: dpOfTick(m?.tickSizeWad), stale: live === "stale" || m?.lastError !== undefined, error: m?.lastError };
  return <VenueRow name="Meridian" q={q} accent />;
});

const PerplRow = memo(function PerplRow() {
  const p = usePerpl(selP);
  const q: Quote = { mark: p?.markWad, bid: p?.bestBidWad, ask: p?.bestAskWad, bookKnown: p?.bookKnown ?? false, dp: p?.priceDecimals ?? 4, stale: p?.stale ?? false, error: p?.lastError };
  return <VenueRow name="Perpl" q={q} accent={false} />;
});

export function MarketHeader() {
  return (
    <Card>
      <View style={s.head}>
        <Text variant="caption" tone="muted">
          MON perpetual
        </Text>
        <BlockPulse />
      </View>
      <MeridianRow />
      <View style={s.rule} />
      <PerplRow />
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  venue: { gap: space.s },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  cols: { flexDirection: "row", gap: space.m, flexWrap: "wrap" },
  col: { flex: 1, minWidth: 96, gap: 2 },
  rule: { height: 1, backgroundColor: colors.border },
});
