// Home (MOBILE_UX_RESEARCH §5.2, MOBILE_PLAN §1.2): one big total AUSD, the per-block heartbeat, Trade / Earn / Add
// funds, and the next step when the wallet is empty. The total is the wallet's AUSD today; venue equity (Meridian
// collateral + equity, Perpl equity) plugs into `venues` in N7 without touching the hero.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useAccountAddress } from "../../auth/AuthProvider";
import { getAppConfig } from "../../config";
import { totalAusdWad, type VenueEquity } from "../../features/home/total";
import { MarketHeader } from "../../features/markets/MarketHeader";
import { Screen } from "../../features/shell/Screen";
import { WalletChip } from "../../features/wallet/WalletChip";
import { useWalletFeed } from "../../features/wallet/WalletFeedProvider";
import { BlockPulse, Button, Card, colors, Num, space, Text, useCountUp } from "../../ui";
import { walletAusdWad } from "../../wallet/arrival";
import type { WalletFeed } from "../../wallet/feed";

const selBalances = (f: WalletFeed) => f.balances;

/** N7: Meridian + Perpl equity. Empty ⇒ the hero is the wallet balance. */
const VENUES: readonly VenueEquity[] = [];

function Hero() {
  const balances = useWalletFeed(selBalances);
  const total = totalAusdWad({ walletWad: walletAusdWad(balances), venues: VENUES });
  const shown = useCountUp(total);
  const stale = Boolean(balances?.error);
  return (
    <Card style={s.hero}>
      <Text variant="caption" tone="muted">
        Total AUSD
      </Text>
      <Num value={shown} kind="usd" variant="hero" stale={stale} label="Total AUSD" testID="home-total" />
      <Text variant="caption" tone="muted">
        {VENUES.length ? "Wallet and trading accounts" : "In your wallet"}
      </Text>
      <View style={s.actions}>
        <Button title="Trade" style={s.grow} onPress={() => router.navigate("/trade")} testID="btn-home-trade" />
        <Button title="Earn" variant="secondary" style={s.grow} onPress={() => router.navigate("/earn")} testID="btn-home-earn" />
      </View>
      <Button title="Add funds" variant="link" onPress={() => router.push("/fund")} testID="btn-home-add" />
      {total === 0n ? <EmptyState /> : null}
    </Card>
  );
}

function EmptyState() {
  const testnet = getAppConfig().chainId !== 143;
  return (
    <View style={s.empty} testID="home-empty">
      <Text bold>Add AUSD to start</Text>
      <Text tone="muted">{testnet ? "This is testnet: get free test funds in two taps." : "Send AUSD to your wallet, then trade or earn."}</Text>
      <Button title={testnet ? "Get test funds" : "Add funds"} variant="secondary" onPress={() => router.push("/fund")} testID="btn-home-empty" />
    </View>
  );
}

export default function Home() {
  const { address } = useAccountAddress();
  return (
    <Screen>
      <View style={s.top}>
        {address ? <WalletChip address={address} /> : <View />}
        <BlockPulse />
      </View>
      <Hero />
      <MarketHeader />
    </Screen>
  );
}

const s = StyleSheet.create({
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m, flexWrap: "wrap" },
  hero: { gap: space.s },
  actions: { flexDirection: "row", gap: space.m, marginTop: space.m, flexWrap: "wrap" },
  grow: { flexGrow: 1, flexBasis: 120 },
  empty: { gap: space.s, marginTop: space.s, paddingTop: space.m, borderTopWidth: 1, borderTopColor: colors.border },
});
