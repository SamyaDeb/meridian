// Pro → Books (research §5.3): Meridian and Perpl side by side, asks above bids, depth bars per venue (core
// meridian/book `ladder`), and the better price on each side highlighted (lower ask, higher bid). An empty side says
// "No liquidity right now"; nothing is invented.
import { ladder, totalSize, type DepthLevel } from "@meridian/core/meridian";
import { wadToFloatForDisplay } from "@meridian/core/util";
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useMeridian, usePerpl } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState } from "../../live/perplMarket";
import { colors, dpOfTick, radius, space, Text } from "../../ui";

const ROWS = 8;
const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;

export type BookSide = { bids: readonly DepthLevel[]; asks: readonly DepthLevel[]; known: boolean; dp: number };

/** Which venue shows the better price per side; undefined = tie or one side unknown. */
export function betterSides(m: BookSide, p: BookSide): { ask: "meridian" | "perpl" | undefined; bid: "meridian" | "perpl" | undefined } {
  const ma = m.asks[0]?.priceWad;
  const pa = p.asks[0]?.priceWad;
  const mb = m.bids[0]?.priceWad;
  const pb = p.bids[0]?.priceWad;
  return {
    ask: ma !== undefined && pa !== undefined && ma !== pa ? (ma < pa ? "meridian" : "perpl") : ma !== undefined && pa === undefined ? "meridian" : pa !== undefined && ma === undefined ? "perpl" : undefined,
    bid: mb !== undefined && pb !== undefined && mb !== pb ? (mb > pb ? "meridian" : "perpl") : mb !== undefined && pb === undefined ? "meridian" : pb !== undefined && mb === undefined ? "perpl" : undefined,
  };
}

const fmt = (wad: bigint, dp: number) => wadToFloatForDisplay(wad).toFixed(dp);
const fmtSize = (wad: bigint) => {
  const v = wadToFloatForDisplay(wad);
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);
};

function Side({ levels, scale, tone, dp, best, asks }: { levels: readonly DepthLevel[]; scale: bigint; tone: "long" | "short"; dp: number; best: boolean; asks: boolean }) {
  const rows = ladder(levels.slice(0, ROWS), scale);
  const shown = asks ? [...rows].reverse() : rows;
  if (rows.length === 0)
    return (
      <Text variant="caption" tone="muted" style={s.empty}>
        No liquidity right now
      </Text>
    );
  return (
    <View>
      {shown.map((r, i) => {
        const isBest = asks ? i === shown.length - 1 : i === 0;
        return (
          <View key={`${r.priceWad}`} style={[s.row, isBest && best && s.bestRow]}>
            <View style={[s.bar, { width: `${Math.max(2, r.depthBps / 100)}%`, backgroundColor: tone === "long" ? colors.long : colors.short }]} />
            <Text variant="caption" tone={tone} bold={isBest} style={s.num}>
              {fmt(r.priceWad, dp)}
            </Text>
            <Text variant="caption" tone="muted" style={s.num}>
              {fmtSize(r.sizeWad)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function VenueBook({ name, b, scale, better, accent }: { name: string; b: BookSide; scale: bigint; better: ReturnType<typeof betterSides>; accent: "meridian" | "perpl" }) {
  return (
    <View style={s.col} accessible accessibilityLabel={`${name} order book${b.known ? "" : ", loading"}`}>
      <View style={s.head}>
        <View style={[s.swatch, { backgroundColor: accent === "meridian" ? colors.brand : colors.text }]} />
        <Text variant="caption" bold>
          {name}
        </Text>
      </View>
      {!b.known ? (
        <Text variant="caption" tone="muted">
          Reading the book…
        </Text>
      ) : (
        <>
          <Side levels={b.asks} scale={scale} tone="short" dp={b.dp} best={better.ask === accent} asks />
          <View style={s.mid} />
          <Side levels={b.bids} scale={scale} tone="long" dp={b.dp} best={better.bid === accent} asks={false} />
        </>
      )}
    </View>
  );
}

export const Books = memo(function Books() {
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const mb: BookSide = { bids: m?.bids ?? [], asks: m?.asks ?? [], known: m?.bookKnown ?? false, dp: dpOfTick(m?.tickSizeWad) };
  const pb: BookSide = { bids: p?.bids ?? [], asks: p?.asks ?? [], known: p?.bookKnown ?? false, dp: p?.priceDecimals ?? 4 };
  // one bar scale per venue (Perpl's book is orders of magnitude deeper; a shared scale would hide Meridian's bars)
  const sm = [totalSize(mb.bids.slice(0, ROWS)), totalSize(mb.asks.slice(0, ROWS))].reduce((a, x) => (x > a ? x : a), 0n);
  const sp = [totalSize(pb.bids.slice(0, ROWS)), totalSize(pb.asks.slice(0, ROWS))].reduce((a, x) => (x > a ? x : a), 0n);
  const better = betterSides(mb, pb);
  return (
    <View>
      <View style={s.legend}>
        <Text variant="caption" tone="muted">
          Price · size (MON). Highlighted: the better price on each side.
        </Text>
      </View>
      <View style={s.cols} testID="pro-books">
        <VenueBook name="Meridian" b={mb} scale={sm} better={better} accent="meridian" />
        <VenueBook name="Perpl" b={pb} scale={sp} better={better} accent="perpl" />
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  legend: { marginBottom: space.s },
  cols: { flexDirection: "row", gap: space.m },
  col: { flex: 1, gap: space.xs },
  head: { flexDirection: "row", alignItems: "center", gap: space.s, marginBottom: space.xs },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2, paddingHorizontal: space.xs, borderRadius: radius.control, overflow: "hidden" },
  bestRow: { borderWidth: 1, borderColor: colors.brand },
  bar: { position: "absolute", right: 0, top: 0, bottom: 0, opacity: 0.12 },
  num: { fontVariant: ["tabular-nums"] },
  mid: { height: 1, backgroundColor: colors.border, marginVertical: space.xs },
  empty: { paddingVertical: space.s },
});
