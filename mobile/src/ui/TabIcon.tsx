// Tab icons drawn with react-native-svg (no icon font): 24 pt, stroke 2, tinted by focus.
import type { ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type TabIconName = "trade" | "earn" | "portfolio" | "settings";

export function TabIcon({ name, color }: { name: TabIconName; color: ColorValue }) {
  const p = { stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === "trade" ? <Path d="M4 16l5-5 4 4 7-8M15 7h5v5" {...p} /> : null}
      {name === "earn" ? (
        <>
          <Circle cx={12} cy={12} r={8} {...p} />
          <Path d="M12 7v10M9 10h4.5a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3H15" {...p} />
        </>
      ) : null}
      {name === "portfolio" ? (
        <>
          <Rect x={3} y={7} width={18} height={13} rx={2} {...p} />
          <Path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" {...p} />
        </>
      ) : null}
      {name === "settings" ? (
        <>
          <Circle cx={12} cy={12} r={3} {...p} />
          <Path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" {...p} />
        </>
      ) : null}
    </Svg>
  );
}
