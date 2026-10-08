// Settings → Perpl (MOBILE_PLAN N4 §5): account id, free collateral, forwarding, trading key rotation, the trading
// socket, "Set up Perpl" while not READY and "Re-enable trading" (a new key at rotation + 1 under a fresh passkey
// prompt, for a lost or revoked token). Dev builds link the IOC round-trip smoke.
import { router } from "expo-router";
import { memo } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Button, Card, haptic, Num, space, Text } from "../../ui";
import { toWad } from "../../wallet/balances";
import type { OnboardingState } from "../../venues/perpl/onboarding";
import { usePerpl, usePerplOnboarding, usePerplSocket } from "../../venues/perpl/PerplProvider";
import type { TradingSocketState } from "../../venues/perpl/tradingSocket";

const selView = (s: OnboardingState | undefined) => s?.view;
const selRecord = (s: OnboardingState | undefined) => s?.record;
const selBusy = (s: OnboardingState | undefined) => s?.busy;
const selError = (s: OnboardingState | undefined) => s?.error;
const selSock = (s: TradingSocketState | undefined) => s;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.row}>
      <Text tone="muted">{label}</Text>
      <View style={s.value}>{children}</View>
    </View>
  );
}

export const SocketLine = memo(function SocketLine() {
  const k = usePerplSocket(selSock);
  if (!k) return <Text>—</Text>;
  const st = k.status === "ready" ? "signed in" : k.status === "connecting" ? "connecting…" : "closed";
  return (
    <Text testID="socket-line">
      {st} · opened {k.opens}× · connects {k.connects}
      {k.head !== undefined ? ` · head ${k.head}` : ""}
    </Text>
  );
});

export function PerplSettings() {
  const venue = usePerpl();
  const view = usePerplOnboarding(selView);
  const rec = usePerplOnboarding(selRecord);
  const busy = usePerplOnboarding(selBusy);
  const error = usePerplOnboarding(selError);
  if (!venue) return null;
  const a = view?.apiAccount;
  const free = a ? BigInt(a.b) - BigInt(a.lb) : undefined;
  return (
    <Card testID="perpl-settings">
      <Text variant="caption" tone="brand" bold>
        Perpl
      </Text>
      <Row label="Status">
        <Text testID="perpl-status">{view ? (view.ready ? "Ready to trade" : view.reason) : "Checking…"}</Text>
      </Row>
      <Row label="Account">
        <Text>{a ? `#${a.id}` : "—"}</Text>
      </Row>
      <Row label="Free collateral">
        <Num value={free !== undefined ? toWad(free, venue.onboarding.collateralDecimals) : undefined} kind="usd" label="Free collateral" />
      </Row>
      <Row label="Fast orders">
        <Text>{a ? (a.fw ? "On" : "Off") : "—"}</Text>
      </Row>
      <Row label="Trading key">
        <Text>{rec ? `rotation ${rec.rotation} · ${rec.publicKeyHex.slice(0, 8)}…${rec.publicKeyHex.slice(-6)}` : "not enabled"}</Text>
      </Row>
      <Row label="Trading connection">
        <SocketLine />
      </Row>
      {error ? (
        <Text tone="short" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {!view?.ready ? <Button title="Set up Perpl" onPress={() => router.push("/perpl")} testID="btn-setup-perpl" /> : null}
      <Button
        title={busy === "enroll" ? "Re-enabling…" : "Re-enable trading"}
        variant="ghost"
        disabled={busy !== undefined && busy !== "refresh"}
        accessibilityHint="Makes a new trading key with your passkey, for when the old one was lost or revoked"
        onPress={() =>
          Alert.alert("Make a new trading key?", "Use this if trading stopped working (key lost or revoked at Perpl). Your passkey is asked once; the old key stops being used.", [
            { text: "Cancel", style: "cancel" },
            { text: "Make new key", onPress: () => void venue.onboarding.reenable().then(() => (haptic.success(), venue.refresh()), () => haptic.error()) },
          ])
        }
        testID="btn-reenable"
      />
      {__DEV__ ? <Button title="Perpl trade smoke (dev)" variant="secondary" onPress={() => router.push("/dev/perpl")} testID="btn-perpl-smoke" /> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  row: { gap: space.xs, minHeight: 44, justifyContent: "center" },
  value: { flexDirection: "row", flexWrap: "wrap" },
});
