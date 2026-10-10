// Welcome: the live funding gap between the two venues before any login (MOBILE_PLAN §1.2 "the hook"), then one button
// (MOBILE_UX_RESEARCH §5.1): "Continue with passkey" → the passkey hero; "Use an existing passkey" signs in right here
// (synced passkey, reinstall, new phone) → "Wallet ready" → Home. A returning wallet on this phone gets Unlock instead.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useAuthController, useAuthState } from "../../auth/AuthProvider";
import { getAppConfig } from "../../config";
import { AuthProgress } from "../../features/auth/AuthProgress";
import { ErrorLine } from "../../features/auth/ErrorLine";
import { useAuthAction } from "../../features/auth/useAuthAction";
import { useWalletReady, WalletReady } from "../../features/auth/WalletReady";
import { Screen } from "../../features/shell/Screen";
import { WalletChip } from "../../features/wallet/WalletChip";
import { SpreadPanel } from "../../features/welcome/SpreadPanel";
import { Button, Card, colors, NetworkBadge, PasskeyIcon, space, Text } from "../../ui";

export const CALM_EXISTING = "No problem — tap Use an existing passkey when ready.";

export default function Welcome() {
  const cfg = getAppConfig();
  const auth = useAuthController();
  const state = useAuthState();
  const { run, error, errorKind, busy } = useAuthAction();
  const { ready, show } = useWalletReady();
  const returning = (state.status === "locked" || state.status === "unlocking") && state.hasAccount;
  const hint = state.status === "locked" || state.status === "unlocking" ? state.addressHint : undefined;
  const blocked = auth.rpProblem;
  if (ready) return <WalletReady />;
  return (
    <Screen
      footer={
        returning ? (
          <Button title="Unlock with your fingerprint" icon={<PasskeyIcon color={colors.onBrand} />} accessibilityHint="Unlocks your wallet with your passkey" onPress={() => router.push("/unlock")} testID="btn-welcome-unlock" />
        ) : (
          <>
            <Button
              title="Continue with passkey"
              icon={<PasskeyIcon color={colors.onBrand} />}
              accessibilityHint="Explains passkeys, then creates your Meridian wallet"
              disabled={busy || Boolean(blocked)}
              onPress={() => router.push("/create")}
              testID="btn-continue-passkey"
            />
            <Button
              title="Use an existing passkey"
              variant="link"
              accessibilityHint="Signs in with a Meridian passkey you already have"
              disabled={busy || Boolean(blocked)}
              onPress={() => void run(() => auth.unlock({ pick: true }), show)}
              testID="btn-existing-passkey"
            />
          </>
        )
      }
    >
      <View style={s.top}>
        <Text variant="title">Meridian</Text>
        <NetworkBadge />
      </View>
      {returning && hint ? <WalletChip address={hint} caption="Welcome back" /> : null}
      <Text variant="title" accessibilityRole="header">
        Trade MON on two order books. Earn the gap.
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
      {blocked ? (
        <Card>
          <Text tone="warn" bold>
            Passkeys are off in this build
          </Text>
          <Text tone="muted">{blocked}</Text>
        </Card>
      ) : null}
      <AuthProgress />
      <ErrorLine message={error} kind={errorKind} calm={CALM_EXISTING} />
    </Screen>
  );
}

const s = StyleSheet.create({ top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m, flexWrap: "wrap" } });
