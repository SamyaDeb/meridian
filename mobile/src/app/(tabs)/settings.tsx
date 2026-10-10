import { router } from "expo-router";
import { memo } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { AlertsCard } from "../../features/alerts/AlertsCard";
import { buildInfo, getAppConfig } from "../../config";
import { Screen } from "../../features/shell/Screen";
import { PerplSettings } from "../../features/perpl/PerplSettings";
import { WalletSettings } from "../../features/wallet/WalletSettings";
import { useBlockBackoff, useBlockSource, useCadence } from "../../live/hooks";
import { BlockPulse, Button, Card, formatValue, NetworkBadge, space, Text } from "../../ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.row}>
      <Text tone="muted">{label}</Text>
      <View style={s.value}>{children}</View>
    </View>
  );
}

/** Measured ms per block over the last minute (core CadenceMeter), integer ms for display. */
const Cadence = memo(function Cadence() {
  const c = useCadence();
  const src = useBlockSource();
  const backoff = useBlockBackoff();
  const ms = c ? formatValue(c.elapsedMs / c.blocks, "int") : "—";
  return (
    <Text style={{ fontVariant: ["tabular-nums"] }} accessibilityLabel={`Block time ${ms} milliseconds, via ${src ?? "nothing"}`}>
      {ms} ms / block · {src === "ws" ? "WebSocket" : src === "poll" ? "polling" : "off"}
      {backoff > 0 ? ` · backing off ${backoff} ms` : ""}
    </Text>
  );
});

export default function Settings() {
  const cfg = getAppConfig();
  const info = buildInfo();
  return (
    <Screen>
      <Text variant="title" accessibilityRole="header">
        Settings
      </Text>
      <WalletSettings />
      <PerplSettings />
      <AlertsCard />
      {cfg.webUrl ? (
        <Card>
          <Button title="Open full terminal" variant="secondary" onPress={() => void Linking.openURL(cfg.webUrl!)} accessibilityHint="Opens the Meridian web terminal in your browser" testID="btn-web-terminal" />
          <Text variant="caption" tone="muted">
            Every order type, depth and history on the web, signed in with the same passkey.
          </Text>
        </Card>
      ) : null}
      <Card>
        <Row label="Network">
          <NetworkBadge />
        </Row>
        <Row label="Head">
          <BlockPulse />
        </Row>
        <Row label="Block time">
          <Cadence />
        </Row>
        <Row label="Passkey domain">
          <Text>{cfg.rpId}</Text>
        </Row>
        <Row label="Version">
          <Text>
            {info.version} ({info.env})
          </Text>
        </Row>
      </Card>
      {__DEV__ ? <Button title="Hermes smoke (dev)" variant="secondary" onPress={() => router.push("/dev/smoke")} /> : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { gap: space.xs, minHeight: 44, justifyContent: "center" },
  value: { flexDirection: "row", flexWrap: "wrap" },
});
