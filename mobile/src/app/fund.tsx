// Add funds (MOBILE_PLAN §1.1, research §5.1/§4): the one place the full address is shown — QR, copy, share — then
// "Waiting for your deposit…" until the wallet feed sees a rise (toast + success haptic + Home count-up). Testnet adds
// "Get test funds". No chain words beyond the network name.
import { router } from "expo-router";
import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAccountAddress } from "../auth/AuthProvider";
import { getAppConfig } from "../config";
import { Screen } from "../features/shell/Screen";
import { AddressActions } from "../features/wallet/AddressActions";
import { BalancesView } from "../features/wallet/Balances";
import { TestFunds } from "../features/wallet/TestFunds";
import { WalletChip } from "../features/wallet/WalletChip";
import { useWalletFeed } from "../features/wallet/WalletFeedProvider";
import { BlockPulse, Button, Card, colors, radius, space, Text } from "../ui";
import type { WalletFeed } from "../wallet/feed";

const selBalances = (f: WalletFeed) => f.balances;
const selLast = (f: WalletFeed) => f.last;

/** "Waiting for your deposit…" until something arrives after this screen opened. */
function ArrivalLine() {
  const last = useWalletFeed(selLast);
  const openedAt = useRef(last?.seq ?? 0);
  const arrived = last && last.seq > openedAt.current ? last : undefined;
  return arrived ? (
    <Text tone="long" bold accessibilityLiveRegion="polite" testID="arrival-line">
      ✓ {arrived.text}
    </Text>
  ) : (
    <View style={s.row} accessibilityLiveRegion="polite">
      <BlockPulse showNumber={false} />
      <Text tone="muted" testID="arrival-line">
        Waiting for your deposit…
      </Text>
    </View>
  );
}

export default function AddFunds() {
  const { address, locked } = useAccountAddress();
  const balances = useWalletFeed(selBalances);
  const cfg = getAppConfig();
  if (!address || locked) return null; // the root guard sends a locked user to Unlock
  return (
    <Screen footer={<Button title="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace("/portfolio"))} testID="btn-fund-done" />}>
      <Text variant="title" accessibilityRole="header">
        Add funds
      </Text>
      <WalletChip address={address} />
      <Text tone="muted">Send AUSD to trade, and a little MON for network fees, on {cfg.chain.name}.</Text>
      <ArrivalLine />
      <Card style={s.center} accessible accessibilityLabel="QR code of your wallet address">
        <View style={s.qr}>
          <QRCode value={address} size={184} color={colors.bg} backgroundColor="#ffffff" quietZone={12} />
        </View>
      </Card>
      <Card>
        <Text variant="caption" tone="muted">
          Your address
        </Text>
        <Text selectable testID="wallet-address" accessibilityLabel={`Your address: ${address.split("").join(" ")}`} style={s.addr}>
          {address}
        </Text>
        <AddressActions address={address} />
      </Card>
      <TestFunds address={address} balances={balances} />
      <BalancesView state={balances} />
    </Screen>
  );
}

const s = StyleSheet.create({
  center: { alignItems: "center" },
  qr: { borderRadius: radius.inner, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.s },
  addr: { fontVariant: ["tabular-nums"], fontFamily: "monospace" },
});
