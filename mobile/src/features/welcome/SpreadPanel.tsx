// Welcome's hook: Meridian vs Perpl funding on MON, and the gap between them, ticking per block. All values through
// core (meridianEffectiveAprWad, perplRateToAprWad, perplRealizedApr, spreadAprWad); unknown ⇒ "—", stale ⇒ marked.
import { wadToFloatForDisplay } from "@meridian/core/util";
import { memo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { useFundingSpread, useLiveness, usePerpl } from "../../live/hooks";
import type { PerplMarketState } from "../../live/perplMarket";
import { BlockPulse, colors, formatValue, Num, space, Text } from "../../ui";

const selPerplStale = (s: PerplMarketState | undefined) => s?.stale ?? false;

/** Plain-language reading of the spread's sign (positive ⇒ Meridian longs pay more than Perpl longs). */
export function spreadSentence(spread: bigint | undefined): string {
  if (spread === undefined) return "Waiting for both venues.";
  if (spread === 0n) return "Both venues charge the same funding right now.";
  const gap = formatValue(spread < 0n ? -spread : spread, "apr");
  return spread > 0n ? `Longs pay ${gap} a year more on Meridian than on Perpl.` : `Longs pay ${gap} a year more on Perpl than on Meridian.`;
}

/** Two venue markers on one axis (with zero), the gap drawn between them. Display floats only. */
function GapAxis({ meridian, perpl }: { meridian: bigint | undefined; perpl: bigint | undefined }) {
  const [w, setW] = useState(0);
  const H = 36;
  const pad = 10;
  const vals = [meridian, perpl].filter((v): v is bigint => v !== undefined).map(wadToFloatForDisplay);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (v: bigint) => pad + ((wadToFloatForDisplay(v) - lo) / span) * Math.max(0, w - 2 * pad);
  const zero = pad + ((0 - lo) / span) * Math.max(0, w - 2 * pad);
  return (
    <View style={{ height: H }} onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {w > 0 ? (
        <Svg width={w} height={H}>
          <Line x1={pad} x2={w - pad} y1={H / 2} y2={H / 2} stroke={colors.border} strokeWidth={2} />
          <Line x1={zero} x2={zero} y1={H / 2 - 8} y2={H / 2 + 8} stroke={colors.muted} strokeWidth={1} />
          {meridian !== undefined && perpl !== undefined ? <Line x1={x(meridian)} x2={x(perpl)} y1={H / 2} y2={H / 2} stroke={colors.brand} strokeWidth={4} strokeLinecap="round" /> : null}
          {perpl !== undefined ? <Circle cx={x(perpl)} cy={H / 2} r={7} fill={colors.bg} stroke={colors.text} strokeWidth={3} /> : null}
          {meridian !== undefined ? <Circle cx={x(meridian)} cy={H / 2} r={7} fill={colors.brand} /> : null}
        </Svg>
      ) : null}
    </View>
  );
}

export const SpreadPanel = memo(function SpreadPanel() {
  const f = useFundingSpread();
  const live = useLiveness();
  const perplStale = usePerpl(selPerplStale);
  const mStale = live === "stale";
  const spreadStale = mStale || perplStale;
  return (
    <View style={s.panel}>
      <View style={s.row}>
        <Text variant="caption" tone="muted">
          Funding gap, MON perps
        </Text>
        <BlockPulse />
      </View>
      <View>
        <Num value={f.spreadAprWad} kind="apr" signed variant="hero" tone="text" stale={spreadStale} label="Funding gap, Meridian minus Perpl, per year" testID="spread" />
        <Text tone="muted">{spreadSentence(f.spreadAprWad)}</Text>
      </View>
      <GapAxis meridian={f.meridianAprWad} perpl={f.perplAprWad} />
      <View style={s.venues}>
        <View style={s.venue}>
          <View style={s.name}>
            <View style={[s.dot, { backgroundColor: colors.brand }]} />
            <Text variant="caption" tone="muted">
              Meridian, now
            </Text>
          </View>
          <Num value={f.meridianAprWad} kind="apr" signed stale={mStale} label="Meridian funding per year" testID="meridian-apr" />
          <Text variant="caption" tone="muted">
            per block, at the measured block time
          </Text>
        </View>
        <View style={s.venue}>
          <View style={s.name}>
            <View style={[s.dot, { borderWidth: 2, borderColor: colors.text }]} />
            <Text variant="caption" tone="muted">
              Perpl, now
            </Text>
          </View>
          <Num value={f.perplAprWad} kind="apr" signed stale={perplStale} label="Perpl funding per year" testID="perpl-apr" />
          <Text variant="caption" tone="muted">
            8 h realized {formatValue(f.perplRealized?.aprWad, "apr", { signed: true })}
          </Text>
        </View>
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  panel: { gap: space.l },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  venues: { flexDirection: "row", gap: space.l, flexWrap: "wrap" },
  venue: { flex: 1, minWidth: 140, gap: 2 },
  name: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
