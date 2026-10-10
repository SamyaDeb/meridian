// Skeletons instead of spinners. Static (no shimmer): a dim block the size of the value it stands in for.
import { View, type DimensionValue } from "react-native";
import { colors, radius } from "./tokens";

export function Skeleton({ width, height = 16, label = "Loading" }: { width: DimensionValue; height?: number; label?: string }) {
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={{ width, height, borderRadius: radius.control, backgroundColor: colors.border }} />;
}
