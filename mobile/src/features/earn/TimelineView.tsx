// The receipt timeline (MOBILE_PLAN N6): one row per leg — a status dot + word (never colour alone), the leg in plain
// words, its fill, the Perpl order id or the Meridian transaction with an explorer link.
import { memo } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Button, colors, space, Text } from "../../ui";
import type { EarnTimeline, StepStatus } from "./timeline";

const STATUS: Record<StepStatus, { word: string; color: string }> = {
  waiting: { word: "Waiting", color: colors.border },
  active: { word: "In progress", color: colors.brand },
  filled: { word: "Filled", color: colors.long },
  partial: { word: "Partly filled", color: colors.warn },
  failed: { word: "Didn't fill", color: colors.short },
  skipped: { word: "Skipped", color: colors.border },
};

export const TimelineView = memo(function TimelineView({ t, testID = "earn-timeline" }: { t: EarnTimeline; testID?: string }) {
  return (
    <View style={s.list} testID={testID}>
      {t.steps.map((st, i) => {
        const look = STATUS[st.status];
        return (
          <View key={st.key} style={s.row} accessible accessibilityLabel={`Step ${i + 1}: ${st.title}. ${look.word}. ${st.detail}`} testID={`${testID}-${st.key}`}>
            <View style={s.rail}>
              <View style={[s.dot, { backgroundColor: look.color }]} />
              {i < t.steps.length - 1 ? <View style={s.line} /> : null}
            </View>
            <View style={s.body}>
              <Text bold>{st.title}</Text>
              <Text variant="caption" tone={st.status === "failed" ? "short" : st.status === "partial" ? "warn" : "muted"} testID={`${testID}-${st.key}-status`}>
                {look.word} · {st.detail}
              </Text>
              {st.orderId !== undefined ? (
                <Text variant="caption" tone="muted">
                  Perpl order #{st.orderId}
                </Text>
              ) : null}
              {st.txHash ? (
                <Text variant="caption" tone="muted">
                  Transaction {st.txHash.slice(0, 10)}…{st.txHash.slice(-6)}
                </Text>
              ) : null}
              {st.txUrl ? <Button title="View on the explorer" variant="link" onPress={() => void Linking.openURL(st.txUrl!)} testID={`${testID}-${st.key}-tx`} /> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
});

const s = StyleSheet.create({
  list: { gap: 0 },
  row: { flexDirection: "row", gap: space.m },
  rail: { width: 14, alignItems: "center" },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  line: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 2 },
  body: { flex: 1, gap: 2, paddingBottom: space.m },
});
