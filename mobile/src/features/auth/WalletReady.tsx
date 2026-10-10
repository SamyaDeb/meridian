// The result half of the FIDO handshake (MOBILE_UX_RESEARCH L4, §5.1 step 3): after the OS sheet, "Wallet ready ✓" for
// READY_MS (the success haptic already fired in useAuthAction), then Home. Never shows the address.
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { colors, space, Text } from "../../ui";

export const READY_MS = 600;
export const HOME = "/portfolio";

export function useWalletReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready) return;
    AccessibilityInfo.announceForAccessibility("Wallet ready");
    const t = setTimeout(() => router.replace(HOME), READY_MS);
    return () => clearTimeout(t);
  }, [ready]);
  const show = useCallback(() => setReady(true), []);
  return { ready, show };
}

export function WalletReady() {
  const reduced = useReducedMotion();
  return (
    <View style={s.root} testID="wallet-ready">
      <Animated.View {...(reduced ? {} : { entering: FadeIn.duration(150) })} style={s.center}>
        <View style={s.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Svg width={40} height={40} viewBox="0 0 24 24">
            <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={colors.onBrand} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
        <Text variant="title" accessibilityRole="header" accessibilityLabel="Wallet ready">
          Wallet ready ✓
        </Text>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center", gap: space.l },
  badge: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.long, alignItems: "center", justifyContent: "center" },
});
