// Returning user: one tap (or the automatic prompt on a fresh launch) unlocks the wallet with the stored passkey.
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useAuthController, useAuthState } from "../../auth/AuthProvider";
import { AuthProgress } from "../../features/auth/AuthProgress";
import { ErrorLine } from "../../features/auth/ErrorLine";
import { useAuthAction } from "../../features/auth/useAuthAction";
import { Screen } from "../../features/shell/Screen";
import { Card, Button, Text } from "../../ui";
import { shortAddress } from "../../wallet/format";

const REASONS: Record<string, string> = {
  idle: "Locked after 10 minutes without activity.",
  background: "Locked while Meridian was in the background.",
  manual: "You locked Meridian.",
};

export default function Unlock() {
  const auth = useAuthController();
  const s = useAuthState();
  const { run, error, busy } = useAuthAction();
  const hint = s.status === "locked" || s.status === "unlocking" ? s.addressHint : undefined;
  const reason = s.status === "locked" ? REASONS[s.reason] : undefined;
  const unlock = () => void run(() => auth.unlock(), () => router.replace("/trade"));

  // fresh launch: prompt straight away (not after an idle/background lock, when the user may not be looking)
  const prompted = useRef(false);
  useEffect(() => {
    if (!prompted.current && s.status === "locked" && s.reason === "start" && s.hasAccount && !auth.rpProblem) {
      prompted.current = true;
      unlock();
    }
  });

  return (
    <Screen
      footer={
        <>
          <Button title="Unlock" accessibilityHint="Unlock your wallet with your passkey" disabled={busy} onPress={unlock} />
          <Button
            title="Use a different passkey"
            variant="ghost"
            disabled={busy}
            onPress={() => void run(() => auth.unlock({ pick: true }), () => router.replace("/trade"))}
          />
        </>
      }
    >
      <Text variant="title" accessibilityRole="header">
        Welcome back
      </Text>
      {hint ? (
        <Card accessible accessibilityLabel={`Wallet ${hint}`}>
          <Text tone="muted" variant="caption">
            Wallet
          </Text>
          <Text style={{ fontVariant: ["tabular-nums"] }}>{shortAddress(hint)}</Text>
        </Card>
      ) : null}
      {reason ? <Text tone="muted">{reason}</Text> : null}
      <AuthProgress />
      <ErrorLine message={error} />
    </Screen>
  );
}
