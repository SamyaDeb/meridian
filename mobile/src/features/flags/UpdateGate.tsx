// Forced update (LAUNCH_PLAN §3.3): when this build is older than the remote `minAppVersion`, a full-screen "Update
// Meridian" covers the app. Its button opens the install link from config (none yet ⇒ "Ask the Meridian team for the new
// version"). "Close my positions" always stays: it drops to the app in close-only mode (every open refuses through
// opensBlocked; Home positions, their Close and Close all keep working), so nobody is locked out of their money.
// The app stays mounted underneath, so persisted executors and resume-after-kill are untouched.
import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { appVersion } from "../../config";
import { useLive } from "../../live/LiveProvider";
import { Button, colors, space, Text } from "../../ui";
import { useFlags } from "./FlagsProvider";

export function UpdateScreen({ onClosePositions }: { onClosePositions: () => void }) {
  const insets = useSafeAreaInsets();
  const { config } = useLive();
  const { flags } = useFlags();
  const url = config.installUrl;
  return (
    <View style={[s.screen, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.l }]} accessibilityViewIsModal testID="update-screen">
      <View style={s.body}>
        <Text variant="title" bold accessibilityRole="header">
          Update Meridian
        </Text>
        <Text>This version of the app is no longer supported. Install the new version to keep trading.</Text>
        {flags.message ? <Text tone="muted">{flags.message}</Text> : null}
        <Text variant="caption" tone="muted" testID="update-versions">
          This app: {appVersion() ?? "—"} · needed: {flags.minAppVersion} or newer
        </Text>
        <Text variant="caption" tone="muted">
          Your funds are onchain and stay yours. You can close your positions from this version.
        </Text>
      </View>
      <View style={s.actions}>
        {url ? (
          <Button title="Get the new version" onPress={() => void Linking.openURL(url)} testID="update-install" />
        ) : (
          <Text bold testID="update-ask">
            Ask the Meridian team for the new version.
          </Text>
        )}
        <Button title="Close my positions" variant="secondary" onPress={onClosePositions} accessibilityHint="Opens your positions. New trades stay off until you update." testID="update-close-positions" />
      </View>
    </View>
  );
}

export function UpdateGate({ children }: { children: ReactNode }) {
  const v = useFlags();
  const insets = useSafeAreaInsets();
  const [closeOnly, setCloseOnly] = useState(false);
  const cover = v.updateRequired && !closeOnly;
  return (
    <View style={s.fill}>
      <View style={s.fill} importantForAccessibility={cover ? "no-hide-descendants" : "auto"}>
        {children}
      </View>
      {v.updateRequired && closeOnly ? (
        <Pressable onPress={() => setCloseOnly(false)} style={[s.banner, { paddingTop: insets.top + space.xs }]} accessibilityRole="button" accessibilityLabel="Update required. Only closing positions is available. Tap to update." testID="update-banner">
          <Text variant="caption" bold>
            Update required · closing only · Update
          </Text>
        </Pressable>
      ) : null}
      {cover ? (
        <UpdateScreen
          onClosePositions={() => {
            setCloseOnly(true);
            // the anchor route sends a locked wallet to Unlock, an unlocked one to Home (positions + Close all)
            router.replace("/");
          }}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  screen: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, paddingHorizontal: space.l, justifyContent: "space-between" },
  body: { gap: space.m },
  actions: { gap: space.m },
  banner: { position: "absolute", top: 0, left: 0, right: 0, paddingBottom: space.xs, paddingHorizontal: space.l, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border, alignItems: "center" },
});
