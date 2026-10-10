// Swipe-to-reveal actions with a visible button fallback (DESIGN.md: never gesture-only). Each action is also an
// accessibility action on the row.
import { useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { Text } from "./Text";
import { colors, HIT, space } from "./tokens";

export type SwipeAction = { key: string; label: string; tone?: "short" | "brand"; onPress: () => void; /** on the visible fallback button (Maestro) */ testID?: string };

export function SwipeRow({ children, actions, label }: { children: ReactNode; actions: readonly SwipeAction[]; label: string }) {
  const ref = useRef<SwipeableMethods>(null);
  const run = (a: SwipeAction) => {
    ref.current?.close();
    a.onPress();
  };
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <View style={s.actions}>
          {actions.map((a) => (
            <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={a.label} onPress={() => run(a)} style={[s.action, { backgroundColor: a.tone === "short" ? colors.short : colors.brand }]}>
              <Text bold style={{ color: colors.onBrand }}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    >
      <View accessible accessibilityLabel={label} accessibilityActions={actions.map((a) => ({ name: a.key, label: a.label }))} onAccessibilityAction={(e) => actions.find((a) => a.key === e.nativeEvent.actionName)?.onPress()} style={s.row}>
        <View style={{ flex: 1 }}>{children}</View>
        <View style={s.fallback}>
          {actions.map((a) => (
            <Pressable key={a.key} accessibilityRole="button" accessibilityLabel={a.label} onPress={() => a.onPress()} hitSlop={8} style={s.fallbackBtn} testID={a.testID}>
              <Text variant="caption" tone={a.tone === "short" ? "short" : "brand"} bold>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ReanimatedSwipeable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, paddingHorizontal: space.l, minHeight: HIT + 12, gap: space.s },
  actions: { flexDirection: "row" },
  action: { width: 88, alignItems: "center", justifyContent: "center" },
  fallback: { flexDirection: "row", gap: space.xs },
  fallbackBtn: { minHeight: HIT, minWidth: HIT, alignItems: "center", justifyContent: "center", paddingHorizontal: space.s },
});
