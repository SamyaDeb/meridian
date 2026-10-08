// Welcome: the live funding gap between the two venues before any login (MOBILE_PLAN §1.2 "the hook").
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { getAppConfig } from "../../config";
import { Screen } from "../../features/shell/Screen";
import { SpreadPanel } from "../../features/welcome/SpreadPanel";
import { Button, Card, NetworkBadge, space, Text } from "../../ui";

export default function Welcome() {
  const cfg = getAppConfig();
  return (
    <Screen
      footer={
        <>
          <Button title="Continue with Face ID" accessibilityHint="Create or unlock your Meridian wallet with a passkey" onPress={() => router.push("/create")} />
          <Button title="Look around first" variant="ghost" onPress={() => router.replace("/trade")} />
        </>
      }
    >
      <View style={s.top}>
        <Text variant="title">Meridian</Text>
        <NetworkBadge />
      </View>
      <Text variant="title" accessibilityRole="header">
        Two order books, one AUSD balance. Trade the best price, or earn the gap.
      </Text>
      {cfg.notLiveReason ? (
        <Card>
          <Text tone="warn" bold>
            Not live in this build
          </Text>
          <Text tone="muted">{cfg.notLiveReason}.</Text>
        </Card>
      ) : null}
      <Card>
        <SpreadPanel />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({ top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m, flexWrap: "wrap" } });
