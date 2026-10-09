// Settings → Wallet: identity (identicon + "Wallet ••a3f2"; the hex only via copy / Add funds), the passkey card, lock
// now, recovery phrase export, sign out (confirmed). Dev builds also show the
// measured key-derivation time and a 0-MON self-transfer (device QA rows 5 and the deriveEvmKey timing).
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useAccountAddress, useAuthController, useDeriveMs } from "../../auth/AuthProvider";
import { Button, Card, haptic, Text } from "../../ui";
import { TxError, type TxResult } from "../../wallet/sendTx";
import { useSendTx } from "../../wallet/hooks";
import { AddressActions } from "./AddressActions";
import { PasskeyCard, PASSKEY_SIGN_OUT } from "./PasskeyCard";
import { WalletChip } from "./WalletChip";

function DevTools({ address }: { address: `0x${string}` }) {
  const deriveMs = useDeriveMs();
  const send = useSendTx();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | undefined>(undefined);
  return (
    <Card>
      <Text variant="caption" tone="brand" bold>
        Dev
      </Text>
      <Text testID="derive-ms">Key derivation: {deriveMs !== undefined ? `${Math.round(deriveMs)} ms` : "—"}</Text>
      <Button
        title="Send 0 MON to myself"
        variant="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setOut("Sending…");
          send({ to: address, value: 0n })
            .then(
              (r: TxResult) => {
                haptic.success();
                setOut(`Confirmed in block ${r.blockNumber} · gas used ${r.gasUsed} · limit ${r.gasLimit} (estimate ${r.gasEstimate} × 1.2) · nonce ${r.nonce}\n${r.hash}`);
              },
              (e: unknown) => {
                haptic.error();
                setOut(e instanceof TxError ? e.message : "The transaction failed. Try again.");
              },
            )
            .finally(() => setBusy(false));
        }}
      />
      {out ? (
        <Text selectable tone="muted" testID="dev-tx">
          {out}
        </Text>
      ) : null}
    </Card>
  );
}

export function WalletSettings() {
  const auth = useAuthController();
  const { address } = useAccountAddress();
  if (!address) return null;
  return (
    <>
      <PasskeyCard />
      <Card>
        <WalletChip address={address} size={40} />
        <AddressActions address={address} />
      </Card>
      <Card>
        <Button title="Lock now" variant="secondary" onPress={() => auth.lock("manual")} />
        <Button title="Export recovery phrase" variant="secondary" accessibilityHint="Asks for your passkey, then shows your 24 words" onPress={() => router.push("/recovery")} />
        <Button
          title="Sign out"
          variant="ghost"
          accessibilityHint="Forgets this wallet on this phone. Your passkey stays in Google Password Manager."
          onPress={() =>
            Alert.alert("Sign out?", PASSKEY_SIGN_OUT, [
              { text: "Cancel", style: "cancel" },
              { text: "Sign out", style: "destructive", onPress: () => void auth.signOut().then(() => router.replace("/welcome")) },
            ])
          }
        />
      </Card>
      {__DEV__ ? <DevTools address={address} /> : null}
    </>
  );
}
