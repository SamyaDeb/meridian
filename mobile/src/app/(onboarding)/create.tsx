// Create a passkey wallet, or sign in with one that already exists (synced passkey, reinstall, new phone).
import { router } from "expo-router";
import { useAuthController } from "../../auth/AuthProvider";
import { AuthProgress } from "../../features/auth/AuthProgress";
import { ErrorLine } from "../../features/auth/ErrorLine";
import { useAuthAction } from "../../features/auth/useAuthAction";
import { Screen } from "../../features/shell/Screen";
import { Button, Card, Text } from "../../ui";

export default function Create() {
  const auth = useAuthController();
  const { run, error, busy } = useAuthAction();
  const blocked = auth.rpProblem;
  return (
    <Screen
      footer={
        <>
          <Button
            title="Create with fingerprint / face"
            accessibilityHint="Creates a passkey for Meridian and a new wallet from it"
            disabled={busy || Boolean(blocked)}
            onPress={() => void run(() => auth.create(), () => router.replace("/fund"))}
          />
          <Button
            title="I already have one"
            variant="secondary"
            accessibilityHint="Sign in with an existing Meridian passkey"
            disabled={busy || Boolean(blocked)}
            onPress={() => void run(() => auth.unlock({ pick: true }), () => router.replace("/trade"))}
          />
          <Button title="Back" variant="ghost" disabled={busy} onPress={() => router.back()} />
        </>
      }
    >
      <Text variant="title" accessibilityRole="header">
        Your wallet
      </Text>
      <Card>
        <Text bold>A passkey is your wallet</Text>
        <Text tone="muted">
          Your fingerprint or face unlocks a passkey saved in your Google Password Manager. Meridian turns it into your wallet on this phone. No seed phrase to
          write down, nothing stored on our servers.
        </Text>
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
      <ErrorLine message={error} />
    </Screen>
  );
}
