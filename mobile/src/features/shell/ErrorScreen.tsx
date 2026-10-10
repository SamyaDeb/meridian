// The calm error screen behind expo-router's `ErrorBoundary` export (app/_layout.tsx for the whole app, and each tab
// route, so one tab's crash leaves the tab bar working). Plain words, Retry (re-renders the route) and a Home path.
// It touches no storage: persisted Trade / Close all / Earn runs stay in SecureStore and resume on the next unlock, as
// after an app kill. No safe-area hook: at the root it renders outside the providers.
import type { ErrorBoundaryProps } from "expo-router";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Button, colors, space, Text } from "../../ui";

export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={s.root} accessibilityLiveRegion="polite" testID="error-screen">
      <View style={s.body}>
        <Text variant="title" bold accessibilityRole="header">
          Something went wrong
        </Text>
        <Text tone="muted">This screen stopped working. Your funds and any order in progress are safe: an order still going through finishes on its own and shows up in Activity.</Text>
        {__DEV__ ? (
          <Text variant="caption" tone="muted" testID="error-detail">
            {error.message}
          </Text>
        ) : null}
      </View>
      <View style={s.actions}>
        <Button title="Try again" onPress={() => void retry()} testID="error-retry" />
        <Button title="Go to Home" variant="secondary" onPress={() => router.replace("/")} accessibilityHint="Unlock or Home, with your positions" testID="error-home" />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: space.l, paddingTop: 64, paddingBottom: space.xl, justifyContent: "space-between" },
  body: { gap: space.m },
  actions: { gap: space.m },
});
