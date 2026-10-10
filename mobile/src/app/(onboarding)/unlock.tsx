// Returning user: one tap (or the automatic prompt on a fresh launch) unlocks the wallet with the stored passkey → Home.
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useAuthController, useAuthState } from "../../auth/AuthProvider";
import { AuthProgress } from "../../features/auth/AuthProgress";
import { ErrorLine } from "../../features/auth/ErrorLine";
import { useAuthAction } from "../../features/auth/useAuthAction";
import { Screen } from "../../features/shell/Screen";
import { HOME } from "../../features/auth/WalletReady";
import { WalletChip } from "../../features/wallet/WalletChip";
import { Button, colors, PasskeyIcon, Text } from "../../ui";

export const CALM_UNLOCK = "No problem — unlock when you're ready.";

const REASONS: Record<string, string> = {
  idle: "Locked after 10 minutes without activity.",
  background: "Locked while Meridian was in the background.",
  manual: "You locked Meridian.",
};

export default function Unlock() {
  const auth = useAuthController();
  const s = useAuthState();
  const { run, error, errorKind, busy } = useAuthAction();
  const hint = s.status === "locked" || s.status === "unlocking" ? s.addressHint : undefined;
  const reason = s.status === "locked" ? REASONS[s.reason] : undefined;
  const unlock = () => void run(() => auth.unlock(), () => router.replace(HOME));

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
          <Button title="Unlock with your fingerprint" icon={<PasskeyIcon color={colors.onBrand} />} accessibilityHint="Unlocks your wallet with your passkey" disabled={busy} onPress={unlock} testID="btn-unlock" />
          <Button
            title="Use a different passkey"
            variant="ghost"
            disabled={busy}
            onPress={() => void run(() => auth.unlock({ pick: true }), () => router.replace(HOME))}
          />
        </>
      }
    >
      <Text variant="title" accessibilityRole="header">
        Welcome back
      </Text>
      {hint ? <WalletChip address={hint} size={40} /> : null}
      {reason ? <Text tone="muted">{reason}</Text> : null}
      <AuthProgress />
      <ErrorLine message={error} kind={errorKind} calm={CALM_UNLOCK} />
    </Screen>
  );
}
