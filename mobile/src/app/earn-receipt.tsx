// Earn receipt (MOBILE_PLAN N6): the outcome in plain words + the timeline of every leg (sent → filled / partly filled /
// unwound, order ids, tx links). Success haptic only when both legs filled (open DONE / close CLOSED); an alert haptic
// when a one-sided leftover needs the one-tap close (shown here and on the Earn screen).
import { router } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useEarn } from "../features/earn/EarnProvider";
import { earnReceiptStore } from "../features/earn/executor";
import { LeftoverClose } from "../features/earn/LeftoverClose";
import type { EarnTimeline } from "../features/earn/timeline";
import { TimelineView } from "../features/earn/TimelineView";
import { Screen } from "../features/shell/Screen";
import { useStore } from "../live/store";
import { Button, Card, colors, haptic, space, Text } from "../ui";

const sel = (t: EarnTimeline | undefined) => t;
const BADGE: Record<EarnTimeline["outcome"], { mark: string; color: string }> = {
  success: { mark: "✓", color: colors.long },
  partial: { mark: "◐", color: colors.warn },
  flat: { mark: "↺", color: colors.muted },
  action: { mark: "!", color: colors.short },
  running: { mark: "…", color: colors.brand },
};

export default function EarnReceiptModal() {
  const t = useStore(earnReceiptStore, sel);
  const { executor } = useEarn();
  useEffect(() => {
    if (t?.outcome === "success" && (t.phase === "DONE" || t.phase === "CLOSED")) haptic.success();
    else if (t?.outcome === "action") haptic.error();
  }, [t]);
  const close = () => {
    earnReceiptStore.set(undefined);
    executor?.reset();
    router.back();
  };
  if (!t)
    return (
      <Screen footer={<Button title="Close" variant="secondary" onPress={close} />}>
        <Text variant="title" accessibilityRole="header">
          Receipt
        </Text>
        <Text tone="muted">No recent Earn order.</Text>
      </Screen>
    );
  const b = BADGE[t.outcome];
  return (
    <Screen footer={<Button title="Done" onPress={close} testID="earn-receipt-done" />}>
      <View style={s.hero}>
        <View style={[s.badge, { backgroundColor: b.color }]}>
          <Text variant="title" bold style={{ color: colors.onBrand }}>
            {b.mark}
          </Text>
        </View>
        <Text variant="title" accessibilityRole="header" testID="earn-receipt-title">
          {t.headline}
        </Text>
        <Text tone="muted" style={s.center} testID="earn-receipt-body">
          {t.body}
        </Text>
      </View>
      {t.leftover ? <LeftoverClose naked={t.leftover} executor={executor} testID="earn-receipt-leftover" /> : null}
      <Card>
        <TimelineView t={t} testID="earn-receipt-timeline" />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: "center", gap: space.s, paddingVertical: space.l },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  center: { textAlign: "center" },
});
