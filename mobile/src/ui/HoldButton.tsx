// Hold-to-confirm: a ring fills on the UI thread over 600 ms; releasing early rewinds and cancels. Haptic on start and
// on success. Screen readers get an `activate` action (double-tap confirms; holding isn't possible with TalkBack).
import { useCallback, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { haptic } from "./haptics";
import { Text } from "./Text";
import { colors, HIT, motion, radius, space } from "./tokens";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const SIZE = 28;
const STROKE = 3;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

export type HoldButtonProps = {
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  holdMs?: number;
  testID?: string;
};

export function HoldButton({ title, onConfirm, disabled, holdMs = motion.holdMs, testID }: HoldButtonProps) {
  const progress = useSharedValue(0);
  const done = useRef(false);

  const complete = useCallback(() => {
    if (done.current) return;
    done.current = true;
    haptic.success();
    onConfirm();
  }, [onConfirm]);

  const start = useCallback(() => {
    if (disabled) return;
    done.current = false;
    haptic.holdStart();
    progress.value = withTiming(1, { duration: holdMs, easing: Easing.linear }, (finished) => {
      if (finished) scheduleOnRN(complete);
    });
  }, [disabled, holdMs, progress, complete]);

  const cancel = useCallback(() => {
    if (done.current) return;
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: motion.holdRewindMs });
  }, [progress]);

  const ring = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - progress.value) }));

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint="Press and hold to confirm"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityActions={[{ name: "activate", label: title }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "activate" && !disabled) complete();
      }}
      disabled={disabled}
      onPressIn={start}
      onPressOut={cancel}
      style={({ pressed }) => [s.base, pressed && s.pressed, disabled && s.disabled]}
    >
      <View style={s.row}>
        <Svg width={SIZE} height={SIZE} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={colors.onBrand} strokeOpacity={0.25} strokeWidth={STROKE} fill="none" />
          <AnimatedCircle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={colors.onBrand} strokeWidth={STROKE} fill="none" strokeDasharray={`${C} ${C}`} animatedProps={ring} strokeLinecap="round" rotation={-90} origin={`${SIZE / 2}, ${SIZE / 2}`} />
        </Svg>
        <Text bold style={{ color: colors.onBrand }}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: { minHeight: HIT + 12, borderRadius: radius.control, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xl },
  row: { flexDirection: "row", alignItems: "center", gap: space.m },
  pressed: { opacity: 0.92 },
  disabled: { opacity: 0.4 },
});
