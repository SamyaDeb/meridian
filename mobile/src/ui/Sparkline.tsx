// Sparkline of display floats (the caller converts bigint WAD with core's wadToFloatForDisplay). < 2 points ⇒ nothing.
import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { colors } from "./tokens";

export const Sparkline = memo(function Sparkline({ points, height = 40, label, zeroLine = true }: { points: readonly number[]; height?: number; label: string; zeroLine?: boolean }) {
  const [width, setWidth] = useState(0);
  const { d, zeroY } = useMemo(() => {
    if (points.length < 2 || width <= 0) return { d: "", zeroY: undefined };
    const lo = Math.min(...points, zeroLine ? 0 : Infinity);
    const hi = Math.max(...points, zeroLine ? 0 : -Infinity);
    const span = hi - lo || 1;
    const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
    const x = (i: number) => (i / (points.length - 1)) * width;
    return { d: points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""), zeroY: zeroLine ? y(0) : undefined };
  }, [points, width, height, zeroLine]);
  return (
    <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessible accessibilityRole="image" accessibilityLabel={label}>
      {d ? (
        <Svg width={width} height={height}>
          {zeroY !== undefined ? <Line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke={colors.border} strokeWidth={1} /> : null}
          <Path d={d} stroke={colors.brand} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </Svg>
      ) : null}
    </View>
  );
});
