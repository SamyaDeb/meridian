// Native price chart (G2: react-native-svg + Reanimated, no new native dep, no WebView). The line is the Perpl last
// price per candle close with the live point per block; horizontal lines for mark, entry and liquidation (a line off the
// visible range is pinned to the edge with an arrow so the liq line never flattens the chart). Scrub: a horizontal drag
// moves the crosshair on the UI thread; each new point under the finger fires one selection haptic and updates the
// price / time label (only the label re-renders). Vertical swipes still scroll the screen.
import { wadToFloatForDisplay } from "@meridian/core/util";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedProps, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { colors, haptic, radius, space, Text } from "../../../ui";
import { placeLine, priceDomain, scrubIndex, type Point } from "./series";

const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type ChartLines = { mark?: bigint | undefined; entry?: bigint | undefined; liq?: bigint | undefined };

const fmtPrice = (wad: bigint, dp: number) => `$${wadToFloatForDisplay(wad).toFixed(dp)}`;

export function timeLabel(tMs: number, resSec: number): string {
  const d = new Date(tMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (resSec >= 86_400) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (resSec >= 3_600) return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hh}:${mm}`;
  return `${hh}:${mm}`;
}

export const PriceChart = memo(function PriceChart({ points, lines, priceDp, resSec, height = 200, testID }: { points: readonly Point[]; lines: ChartLines; priceDp: number; resSec: number; height?: number; testID?: string }) {
  const [width, setWidth] = useState(0);
  const [sel, setSel] = useState<number | undefined>(undefined);

  const geo = useMemo(() => {
    const ys = points.map((p) => wadToFloatForDisplay(p.priceWad));
    const keep = [lines.mark, lines.entry].filter((v): v is bigint => v !== undefined).map(wadToFloatForDisplay);
    const dom = priceDomain(ys, keep);
    const n = ys.length;
    const X = (i: number) => (n <= 1 ? width : (i / (n - 1)) * width);
    const Y = (v: number) => placeLine(v, dom, height).y;
    let d = "";
    ys.forEach((v, i) => (d += `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`));
    return { d, px: ys.map((_, i) => X(i)), py: ys.map(Y), dom };
  }, [points, lines.mark, lines.entry, width, height]);

  const xs = useSharedValue<number[]>([]);
  const ys = useSharedValue<number[]>([]);
  useEffect(() => {
    xs.value = geo.px;
    ys.value = geo.py;
  }, [geo, xs, ys]);
  const x = useSharedValue(0);
  const on = useSharedValue(0);
  const idx = useSharedValue(-1);
  const w = useSharedValue(0);

  const pick = useCallback((i: number) => {
    haptic.selection();
    setSel(i < 0 ? undefined : i);
  }, []);

  const pan = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-14, 14])
    .onBegin((e) => {
      x.value = e.x;
    })
    .onStart(() => {
      on.value = 1;
    })
    .onUpdate((e) => {
      x.value = e.x;
      const i = scrubIndex(e.x, w.value, xs.value.length);
      if (i !== idx.value) {
        idx.value = i;
        scheduleOnRN(pick, i);
      }
    })
    .onFinalize(() => {
      on.value = 0;
      idx.value = -1;
      scheduleOnRN(setSel, undefined);
    });

  const cross = useAnimatedProps(() => {
    const i = idx.value;
    const cx = i >= 0 && i < xs.value.length ? xs.value[i]! : x.value;
    return { x1: cx, x2: cx, strokeOpacity: on.value };
  });
  const dot = useAnimatedProps(() => {
    const i = idx.value;
    const ok = i >= 0 && i < xs.value.length;
    return { cx: ok ? xs.value[i]! : 0, cy: ok ? ys.value[i]! : 0, opacity: ok ? on.value : 0 };
  });
  const labelStyle = useAnimatedStyle(() => ({ opacity: on.value }));

  const line = (key: keyof ChartLines, label: string, color: string) => {
    const v = lines[key];
    if (v === undefined || width <= 0) return null;
    const p = placeLine(wadToFloatForDisplay(v), geo.dom, height);
    const arrow = p.off === "above" ? "▲ " : p.off === "below" ? "▼ " : "";
    const y = Math.min(height - 1, Math.max(1, p.y));
    return (
      <View key={key} pointerEvents="none" style={[s.lineLabel, { top: Math.min(height - 18, Math.max(0, y - 9)) }]} accessible accessibilityLabel={`${label} ${fmtPrice(v, priceDp)}${p.off ? `, ${p.off} the chart` : ""}`}>
        <Text variant="caption" style={{ color }}>
          {arrow}
          {label} {fmtPrice(v, priceDp)}
        </Text>
      </View>
    );
  };
  const lineSvg = (key: keyof ChartLines, color: string, dash: string) => {
    const v = lines[key];
    if (v === undefined || width <= 0) return null;
    const p = placeLine(wadToFloatForDisplay(v), geo.dom, height);
    const y = Math.min(height - 1, Math.max(1, p.y));
    return <Line key={key} x1={0} x2={width} y1={y} y2={y} stroke={color} strokeWidth={1} strokeDasharray={dash} strokeOpacity={p.off ? 0.5 : 0.9} />;
  };

  const selected = sel !== undefined ? points[sel] : undefined;
  const last = points.at(-1);
  const summary = last ? `MON price chart, ${points.length} points, last ${fmtPrice(last.priceWad, priceDp)}` : "MON price chart, loading";

  return (
    <View testID={testID}>
      <View style={s.labelRow}>
        <Animated.View style={labelStyle}>
          <Text variant="caption" bold testID="chart-scrub-label">
            {selected ? `${fmtPrice(selected.priceWad, priceDp)} · ${timeLabel(selected.t, resSec)}${selected.gap ? " · no trades" : ""}` : " "}
          </Text>
        </Animated.View>
      </View>
      <GestureDetector gesture={pan}>
        <View
          style={{ height }}
          onLayout={(e) => {
            setWidth(e.nativeEvent.layout.width);
            w.value = e.nativeEvent.layout.width;
          }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={summary}
        >
          {width > 0 && points.length > 1 ? (
            <Svg width={width} height={height}>
              {lineSvg("mark", colors.muted, "2 4")}
              {lineSvg("entry", colors.brandSoft, "6 4")}
              {lineSvg("liq", colors.short, "4 3")}
              <Path d={geo.d} stroke={colors.brand} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
              <AnimatedLine y1={0} y2={height} stroke={colors.text} strokeWidth={1} animatedProps={cross} />
              <AnimatedCircle r={4} fill={colors.text} stroke={colors.bg} strokeWidth={2} animatedProps={dot} />
            </Svg>
          ) : (
            <View style={[s.empty, { height }]}>
              <Text tone="muted" variant="caption">
                {points.length === 0 ? "Loading the chart…" : "Waiting for the next price"}
              </Text>
            </View>
          )}
          {line("mark", "mark", colors.muted)}
          {line("entry", "entry", colors.brandSoft)}
          {line("liq", "liq", colors.short)}
        </View>
      </GestureDetector>
    </View>
  );
});

const s = StyleSheet.create({
  labelRow: { minHeight: 18, marginBottom: space.xs },
  lineLabel: { position: "absolute", right: 0, backgroundColor: colors.card, borderRadius: radius.control, paddingHorizontal: space.xs },
  empty: { alignItems: "center", justifyContent: "center" },
});
