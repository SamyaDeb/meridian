// Per-block heartbeat: a dot that flashes on every new head + the block number. Its own leaf: a block tick re-renders
// only this component. Stale ⇒ warn colour + "stale"; waiting ⇒ "—".
import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { useBlockNumber, useLiveness } from "../live/hooks";
import { formatValue } from "./format";
import { Text } from "./Text";
import { colors, motion, space } from "./tokens";

export const BlockPulse = memo(function BlockPulse({ showNumber = true }: { showNumber?: boolean }) {
  const block = useBlockNumber();
  const live = useLiveness();
  const reduced = useReducedMotion();
  const flash = useSharedValue(0);

  useEffect(() => {
    if (block === undefined || reduced) return;
    flash.value = withSequence(withTiming(1, { duration: 40 }), withTiming(0, { duration: motion.pulseMs }));
  }, [block, reduced, flash]);

  const halo = useAnimatedStyle(() => ({ opacity: flash.value, transform: [{ scale: 1 + flash.value }] }));
  const dot = live === "live" ? colors.brand : live === "stale" ? colors.warn : colors.muted;
  const label = live === "waiting" ? "Waiting for the first block" : `Block ${block?.toString() ?? "unknown"}${live === "stale" ? ", stale" : ""}`;

  return (
    <View style={s.row} accessible accessibilityRole="text" accessibilityLabel={label}>
      <View style={s.dotBox}>
        <Animated.View style={[s.halo, { backgroundColor: colors.brand }, halo]} />
        <View style={[s.dot, { backgroundColor: dot }]} />
      </View>
      {showNumber ? (
        <Text variant="caption" tone={live === "live" ? "muted" : "warn"} style={{ fontVariant: ["tabular-nums"] }}>
          {live === "waiting" ? "—" : `#${formatValue(block, "block")}`}
          {live === "stale" ? " stale" : ""}
        </Text>
      ) : null}
    </View>
  );
});

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.s },
  dotBox: { width: 12, height: 12, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  halo: { position: "absolute", width: 8, height: 8, borderRadius: 4 },
});
