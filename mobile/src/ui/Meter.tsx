// Horizontal meter (liq distance, utilisation): 0..10 000 bps. Unknown ⇒ an empty track and "—" spoken.
import Svg, { Rect } from "react-native-svg";
import { View } from "react-native";
import { colors } from "./tokens";

export function Meter({ bps, label, tone = "brand", height = 6 }: { bps: number | undefined; label: string; tone?: "brand" | "long" | "short" | "warn"; height?: number }) {
  const f = bps === undefined ? 0 : Math.min(10_000, Math.max(0, bps)) / 10_000;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={bps === undefined ? { text: "unknown" } : { min: 0, max: 100, now: Math.round(f * 100) }}>
      <Svg width="100%" height={height}>
        <Rect x={0} y={0} width="100%" height={height} rx={height / 2} fill={colors.border} />
        {f > 0 ? <Rect x={0} y={0} width={`${f * 100}%`} height={height} rx={height / 2} fill={colors[tone]} /> : null}
      </Svg>
    </View>
  );
}
