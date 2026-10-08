// Welcome: the live funding gap between the two venues before any login (MOBILE_PLAN §1.2 "the hook").
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useAuthState } from "../../auth/AuthProvider";
import { getAppConfig } from "../../config";
import { Screen } from "../../features/shell/Screen";
import { SpreadPanel } from "../../features/welcome/SpreadPanel";
import { Button, Card, NetworkBadge, space, Text } from "../../ui";
import { shortAddress } from "../../wallet/format";

export default function Welcome() {
  const cfg = getAppConfig();
  const auth = useAuthState();
  const returning = (auth.status === "locked" || auth.status === "unlocking") && auth.hasAccount;
  const hint = auth.status === "locked" || auth.status === "unlocking" ? auth.addressHint : undefined;
  return (
    <Screen
      footer={
        returning ? (
          <Button title="Unlock" accessibilityHint={`Unlock wallet ${hint ?? ""} with your passkey`} onPress={() => router.push("/unlock")} />
        ) : (
          <Button title="Continue with fingerprint / face" accessibilityHint="Create or sign in to your Meridian wallet with a passkey" onPress={() => router.push("/create")} />
        )
      }
    >
      <View style={s.top}>
        <Text variant="title">Meridian</Text>
        <NetworkBadge />
      </View>
      {hint ? <Text tone="muted">Welcome back {shortAddress(hint)}</Text> : null}
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
