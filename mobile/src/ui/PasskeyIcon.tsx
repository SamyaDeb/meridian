// The passkey symbol (FIDO design guidelines: a person with a key), drawn with react-native-svg. Decorative: the label
// next to it carries the meaning, so it is hidden from screen readers.
import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

export function PasskeyIcon({ size = 24, color }: { size?: number; color: ColorValue }) {
  const p = { stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="passkey-icon">
      <Circle cx={9} cy={7} r={4} {...p} />
      <Path d="M2 21v-1a6 6 0 016-6h2.5" {...p} />
      <Circle cx={18} cy={12.5} r={2.5} {...p} />
      <Path d="M18 15v6M18 18.5h2M18 21h1.5" {...p} />
    </Svg>
  );
}
