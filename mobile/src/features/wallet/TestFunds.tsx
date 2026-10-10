// Testnet only: "Get test funds" in two taps — test MON from the Monad faucet (fees), then 10,000 test AUSD minted from
// Meridian's AUSD mock. The arrival toast confirms the AUSD; errors stay on the card.
import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { getAppConfig } from "../../config";
import { Button, Card, haptic, space, Text } from "../../ui";
import { formatValue } from "../../ui/format";
import { balanceTokens, type BalanceState } from "../../wallet/balances";
import { useSendTx } from "../../wallet/hooks";
import { TxError } from "../../wallet/sendTx";
import { mintableTestAusd, mintTestAusdTx, TEST_AUSD_WHOLE, TESTNET_FAUCET } from "../../wallet/testFunds";

export function TestFunds({ address, balances }: { address: `0x${string}`; balances: BalanceState | undefined }) {
  const cfg = getAppConfig();
  const token = mintableTestAusd(cfg);
  const send = useSendTx();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (cfg.chainId === 143) return null;
  const ausdLabel = balanceTokens(cfg).find((t) => t.key === "ausd")?.label;
  const decimals = balances?.tokens.find((t) => t.label === ausdLabel)?.decimals;
  const noMon = balances?.mon === undefined || balances.mon === 0n;
  const whole = formatValue(TEST_AUSD_WHOLE * 10n ** 18n, "usd", { dp: 0 });
  return (
    <Card testID="test-funds">
      <Text bold>Get test funds</Text>
      <Text tone="muted">Testnet money has no value. Get a little test MON for network fees first, then test AUSD to trade with.</Text>
      <View style={s.step}>
        <Text>1. Test MON</Text>
        <Button title="Open the Monad faucet" variant="secondary" accessibilityRole="link" onPress={() => void Linking.openURL(TESTNET_FAUCET)} testID="btn-faucet" />
      </View>
      {token ? (
        <View style={s.step}>
          <Text>2. Test AUSD</Text>
          <Button
            title={busy ? "Getting test AUSD…" : `Get ${whole} test AUSD`}
            disabled={busy || noMon || decimals === undefined}
            accessibilityHint="Sends one testnet transaction from your wallet"
            onPress={() => {
              setBusy(true);
              setError(undefined);
              send(mintTestAusdTx(token, address, decimals!))
                .catch((e: unknown) => {
                  haptic.error();
                  setError(e instanceof TxError ? e.message : "Couldn't get test AUSD. Check your connection and try again.");
                })
                .finally(() => setBusy(false));
            }}
            testID="btn-mint"
          />
          {noMon ? (
            <Text variant="caption" tone="muted">
              Needs a little test MON for the network fee: step 1 first.
            </Text>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text tone="short" accessibilityRole="alert" testID="test-funds-error">
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const s = StyleSheet.create({ step: { gap: space.s } });
