// What the passkey flow is doing right now. "Unlocking…" fades in only if key derivation takes > 300 ms: the delay runs
// on the UI thread (Reanimated), so it still fires while the synchronous derivation blocks JS.
import Animated, { FadeIn } from "react-native-reanimated";
import { useAuthState } from "../../auth/AuthProvider";
import { Text } from "../../ui";

export function AuthProgress() {
  const s = useAuthState();
  if (s.status !== "unlocking") return null;
  if (s.step === "passkey")
    return (
      <Text tone="muted" accessibilityLiveRegion="polite">
        Waiting for your fingerprint or face…
      </Text>
    );
  return (
    <Animated.View entering={FadeIn.delay(300).duration(150)}>
      <Text tone="muted" accessibilityLiveRegion="polite">
        Unlocking…
      </Text>
    </Animated.View>
  );
}
