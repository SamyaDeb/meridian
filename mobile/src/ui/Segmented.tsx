import { Pressable, StyleSheet, View } from "react-native";
import { haptic } from "./haptics";
import { Text } from "./Text";
import { colors, HIT, radius, space } from "./tokens";

export type SegmentedProps<T extends string> = {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  accessibilityLabel: string;
};

export function Segmented<T extends string>({ options, value, onChange, accessibilityLabel }: SegmentedProps<T>) {
  return (
    <View style={s.track} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              haptic.selection();
              onChange(o.value);
            }}
            style={[s.seg, selected && s.selected]}
          >
            <Text variant="body" bold={selected} tone={selected ? "text" : "muted"}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  track: { flexDirection: "row", backgroundColor: colors.card, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: space.xs },
  seg: { flex: 1, minHeight: HIT, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", paddingHorizontal: space.m },
  selected: { backgroundColor: colors.brandTint, borderWidth: 1, borderColor: colors.brand },
});
