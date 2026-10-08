// Shown while NetInfo reports no connection. Later phases also read `writesDisabled` before sending anything.
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNetwork } from "../live/hooks";
import { Text } from "./Text";
import { colors, space } from "./tokens";

const selOffline = (n: { online: boolean | undefined }) => n.online === false;

export function OfflineBanner() {
  const offline = useNetwork(selOffline);
  const insets = useSafeAreaInsets();
  if (!offline) return null;
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={[s.bar, { paddingTop: insets.top + space.xs }]} accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <View style={s.inner}>
        <Text variant="caption" bold style={{ color: colors.onBrand }}>
          You're offline. Prices are paused and trading is off until you reconnect.
        </Text>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: colors.warn, zIndex: 10 },
  inner: { paddingHorizontal: space.l, paddingBottom: space.s },
});
