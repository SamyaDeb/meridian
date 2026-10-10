// The passkey hero (FIDO handshake, MOBILE_UX_RESEARCH L4–L6 / §5.1): symbol + headline + plain message + one CTA before
// the OS sheet, "Wallet ready ✓" after it, then Home. Copy is FIDO's tested wording (L5) adapted per §5.1 — keep verbatim.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useAuthController } from "../../auth/AuthProvider";
import { AuthProgress } from "../../features/auth/AuthProgress";
import { ErrorLine } from "../../features/auth/ErrorLine";
import { useAuthAction } from "../../features/auth/useAuthAction";
import { useWalletReady, WalletReady } from "../../features/auth/WalletReady";
import { Screen } from "../../features/shell/Screen";
import { Button, Card, colors, PasskeyIcon, space, Text } from "../../ui";

export const HERO_TITLE = "Your fingerprint is your wallet";
export const HERO_BODY =
  "Passkeys are encrypted digital keys you create using your fingerprint, face, or screen lock. Saved in Google Password Manager, so a new phone signs you back in.";
export const CALM_CREATE = "No problem — tap Create when ready";

export default function Create() {
  const auth = useAuthController();
  const { run, error, errorKind, busy } = useAuthAction();
  const { ready, show } = useWalletReady();
  const blocked = auth.rpProblem;
  if (ready) return <WalletReady />;
  return (
    <Screen
      footer={
        <>
          <Button
            title="Create my wallet"
            accessibilityHint="Opens your phone's passkey prompt"
            disabled={busy || Boolean(blocked)}
            onPress={() => void run(() => auth.create(), show)}
            testID="btn-create-wallet"
          />
          <Button title="Back" variant="ghost" disabled={busy} onPress={() => router.back()} />
        </>
      }
    >
      <View style={s.hero}>
        <View style={s.symbol}>
          <PasskeyIcon size={40} color={colors.brandSoft} />
        </View>
        <Text variant="title" accessibilityRole="header" style={s.center}>
          {HERO_TITLE}
        </Text>
        <Text tone="muted" style={s.center}>
          {HERO_BODY}
        </Text>
        <Text tone="muted" variant="caption" style={s.center}>
          No seed phrase to write down. Nothing stored on our servers.
        </Text>
      </View>
      {blocked ? (
        <Card>
          <Text tone="warn" bold>
            Passkeys are off in this build
          </Text>
          <Text tone="muted">{blocked}</Text>
        </Card>
      ) : null}
      <AuthProgress />
      <ErrorLine message={error} kind={errorKind} calm={CALM_CREATE} />
    </Screen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: "center", gap: space.l, paddingTop: space.xxxl },
  symbol: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" },
  center: { textAlign: "center" },
});
