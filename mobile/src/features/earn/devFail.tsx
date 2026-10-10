// Dev-only (MOBILE_PLAN N6 deliverable 4): force the Meridian OPEN leg to fail before it is sent, so the auto-unwind of
// the Perpl leg can be tried on a phone. Required only behind `__DEV__` (EarnProvider, the Earn screen); Metro inlines
// __DEV__ = false in release and drops the require, and check:release greps the bundle for DEV_FAIL_MARKER.
import type { LegAdapter } from "@meridian/core/exec";
import { StyleSheet, Switch, View } from "react-native";
import { colors, space, Text } from "../../ui";

export const DEV_FAIL_MARKER = "meridian-dev-force-meridian-fail";
export const DEV_FAIL_ERROR = "Dev flag: the Meridian leg was forced to fail before sending.";

export function withForcedMeridianFailure(legs: LegAdapter): LegAdapter {
  return {
    ...legs,
    async prepare(leg) {
      if (leg.venue === "meridian" && !leg.reduceOnly) throw new Error(DEV_FAIL_ERROR);
      return legs.prepare(leg);
    },
  };
}

export function DevFailToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row} testID={DEV_FAIL_MARKER}>
      <Text variant="caption" tone="warn" style={s.text}>
        Dev: force the Meridian leg to fail (tests the auto-unwind)
      </Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.warn, false: colors.border }} accessibilityLabel="Dev: force the Meridian leg to fail" testID="dev-fail-meridian" />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.m, padding: space.m, borderRadius: 10, borderWidth: 1, borderColor: colors.warn },
  text: { flex: 1 },
});
