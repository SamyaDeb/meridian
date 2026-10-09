// The shared transactional numpad (research M6, Coinbase CDS pattern): big amount, presets, a 3 × 4 keypad with a
// light haptic per key, the locale's decimal separator, no OS keyboard. Text model in ./amountText (tested). Reused by
// N6 Earn.
import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { colors, haptic, HIT, radius, space, Text } from "../../../ui";
import { decimalSeparator, displayAmount, NUMPAD_KEYS, pressKey, type NumpadKey } from "./amountText";

export type Preset = { label: string; text: string };

export const Numpad = memo(function Numpad({ text, onChange, presets, unit = "AUSD", caption, testID = "numpad" }: { text: string; onChange: (t: string) => void; presets: readonly Preset[]; unit?: string; caption?: string; testID?: string }) {
  const sep = useMemo(() => decimalSeparator(), []);
  const tap = (k: NumpadKey) => {
    haptic.holdStart(); // DESIGN.md haptics: a light impact per key
    onChange(pressKey(text, k));
  };
  return (
    <View style={s.wrap}>
      <View style={s.amount} accessible accessibilityRole="text" accessibilityLabel={`Amount ${text === "" ? "zero" : text} ${unit}`} accessibilityLiveRegion="polite">
        <Text variant="hero" bold tone={text === "" ? "muted" : "text"} style={s.num} testID={`${testID}-amount`}>
          {displayAmount(text, sep)}
        </Text>
        <Text tone="muted">{unit}</Text>
      </View>
      {caption ? (
        <Text variant="caption" tone="muted" style={s.center}>
          {caption}
        </Text>
      ) : null}
      <View style={s.presets}>
        {presets.map((p) => (
          <Pressable
            key={p.label}
            accessibilityRole="button"
            accessibilityLabel={`${p.label}${p.text ? `, ${p.text} ${unit}` : ", nothing available"}`}
            disabled={p.text === ""}
            onPress={() => {
              haptic.selection();
              onChange(p.text);
            }}
            style={({ pressed }) => [s.preset, pressed && s.pressed, p.text === "" && s.disabled]}
            testID={`${testID}-preset-${p.label}`}
          >
            <Text variant="caption" bold>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.grid}>
        {NUMPAD_KEYS.map((k) => (
          <Pressable key={k} accessibilityRole="button" accessibilityLabel={k === "back" ? "Delete" : k === "." ? "Decimal point" : k} onPress={() => tap(k)} onLongPress={k === "back" ? () => onChange("") : undefined} style={({ pressed }) => [s.key, pressed && s.keyPressed]} testID={`${testID}-key-${k}`}>
            <Text variant="title" bold>
              {k === "back" ? "⌫" : k === "." ? sep : k}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  wrap: { gap: space.m },
  amount: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: space.s },
  num: { fontVariant: ["tabular-nums"] },
  center: { textAlign: "center" },
  presets: { flexDirection: "row", gap: space.s, justifyContent: "center" },
  preset: { minHeight: HIT - 8, minWidth: 72, paddingHorizontal: space.m, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.brandTint },
  disabled: { opacity: 0.4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  key: { width: "33.333%", height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.inner },
  keyPressed: { backgroundColor: colors.brandTint },
});
