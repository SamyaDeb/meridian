// Discrete slider with haptic detents (leverage, size %). Gesture on the UI thread; the value snaps to `steps` and a
// selection haptic fires on every detent crossed. Screen readers adjust it with increment / decrement.
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptic } from "./haptics";
import { colors, HIT, radius } from "./tokens";

export type SliderProps = {
  steps: readonly number[];
  index: number;
  onChange: (index: number) => void;
  accessibilityLabel: string;
  /** spoken value for a step, e.g. (i) => `${steps[i]}x` */
  describe: (index: number) => string;
};

const THUMB = 28;

export function Slider({ steps, index, onChange, accessibilityLabel, describe }: SliderProps) {
  const [width, setWidth] = useState(0);
  const last = steps.length - 1;
  const pos = useSharedValue(last > 0 ? index / last : 0);
  const current = useSharedValue(index);
  const w = useSharedValue(0);

  // follow external changes of `index`
  useEffect(() => {
    pos.value = last > 0 ? index / last : 0;
    current.value = index;
  }, [index, last, pos, current]);

  const emit = useCallback(
    (i: number) => {
      haptic.selection();
      onChange(i);
    },
    [onChange],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
    w.value = e.nativeEvent.layout.width;
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onUpdate((e) => {
      if (w.value <= 0 || last <= 0) return;
      const f = Math.min(1, Math.max(0, e.x / w.value));
      const i = Math.round(f * last);
      pos.value = i / last;
      if (i !== current.value) {
        current.value = i;
        scheduleOnRN(emit, i);
      }
    });

  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: pos.value * Math.max(0, w.value - THUMB) }] }));
  const fill = useAnimatedStyle(() => ({ width: THUMB / 2 + pos.value * Math.max(0, w.value - THUMB) }));

  const step = (d: number) => {
    const i = Math.min(last, Math.max(0, index + d));
    if (i === index) return;
    pos.value = last > 0 ? i / last : 0;
    current.value = i;
    emit(i);
  };

  return (
    <GestureDetector gesture={pan}>
      <View
        style={s.hit}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: describe(index) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}
      >
        <View style={s.track} />
        <Animated.View style={[s.fill, fill]} />
        {width > 0 ? steps.map((_, i) => <View key={i} style={[s.tick, { left: THUMB / 2 + (last > 0 ? (i / last) * (width - THUMB) : 0) - 1 }]} />) : null}
        <Animated.View style={[s.thumb, thumb]} />
      </View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  hit: { height: HIT, justifyContent: "center" },
  track: { height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginHorizontal: THUMB / 2 },
  fill: { position: "absolute", left: 0, height: 4, borderRadius: radius.pill, backgroundColor: colors.brand },
  tick: { position: "absolute", width: 2, height: 8, backgroundColor: colors.muted, borderRadius: 1 },
  thumb: { position: "absolute", left: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: colors.text, borderWidth: 3, borderColor: colors.brand },
});
