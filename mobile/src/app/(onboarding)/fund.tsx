// Fund the wallet: address + QR, live MON / AUSD balances per block, the testnet faucet link (ARCHITECTURE R29).
import { router } from "expo-router";
import { Linking, StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAccountAddress } from "../../auth/AuthProvider";
import { getAppConfig } from "../../config";
import { Screen } from "../../features/shell/Screen";
import { AddressCard } from "../../features/wallet/AddressCard";
import { Balances } from "../../features/wallet/Balances";
import { Button, Card, colors, Text } from "../../ui";

/** Monad testnet faucet: docs/ARCHITECTURE.md R29 (docs.monad.xyz/developer-essentials/testnet). */
const TESTNET_FAUCET = "https://faucet.monad.xyz";

export default function Fund() {
  const { address, locked } = useAccountAddress();
  const cfg = getAppConfig();
  if (!address || locked) return null; // the layout guard sends a locked user to Unlock
  return (
    <Screen footer={<Button title="Continue" onPress={() => router.replace("/trade")} />}>
      <Text variant="title" accessibilityRole="header">
        Add funds
      </Text>
      <Text tone="muted">Send AUSD to trade and a little MON for network fees to this address on {cfg.chain.name}.</Text>
      <Card style={s.qrCard} accessible accessibilityLabel="QR code of your address">
        <View style={s.qr}>
          <QRCode value={address} size={184} color={colors.bg} backgroundColor="#ffffff" quietZone={12} />
        </View>
      </Card>
      <AddressCard address={address} />
      <Balances address={address} />
      {cfg.chainId === 10143 ? (
        <Card>
          <Text bold>Testnet MON</Text>
          <Text tone="muted">Get free testnet MON for fees from the Monad faucet, then come back: your balance updates by itself.</Text>
          <Button title="Open the Monad faucet" variant="secondary" accessibilityRole="link" onPress={() => void Linking.openURL(TESTNET_FAUCET)} />
        </Card>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({ qrCard: { alignItems: "center" }, qr: { borderRadius: 10, overflow: "hidden" } });
