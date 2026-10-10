// Home (MOBILE_UX_RESEARCH §5.2, MOBILE_PLAN §1.2 / N7): one honest total AUSD across the wallet and both venues (any
// unknown part ⇒ "—", the breakdown sheet says which and why), live open PnL per block, the heartbeat, Trade / Earn /
// Add funds, the next step when everything is empty, the open positions (swipe Close + visible Close, funding, liq
// meter; a basis pair grouped), and the latest Activity rows, each one tap to its receipt. Pull to refresh.
import { router } from "expo-router";
import { memo, useEffect, useRef } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useAccountAddress } from "../../auth/AuthProvider";
import { getAppConfig } from "../../config";
import { ActivityList } from "../../features/activity/ActivityList";
import { useActivity } from "../../features/activity/ActivityProvider";
import type { ActivityState } from "../../features/activity/feed";
import { openPnl, totalAusdWad, VENUE_LABEL, venueEquities, type VenueEquity } from "../../features/home/total";
import { MarketHeader } from "../../features/markets/MarketHeader";
import { Screen } from "../../features/shell/Screen";
import type { AccountsState } from "../../features/trade/data/accounts";
import { useEarnPair } from "../../features/earn/EarnProvider";
import { PositionCards } from "../../features/trade/positions/PositionCards";
import { useAccountReadsWhileFocused, useTrade } from "../../features/trade/TradeProvider";
import { WalletChip } from "../../features/wallet/WalletChip";
import { useWalletFeed } from "../../features/wallet/WalletFeedProvider";
import { Store, useStore } from "../../live/store";
import { BlockPulse, Button, Card, colors, Num, Sheet, space, Text, useCountUp, type SheetRef } from "../../ui";
import { walletAusdWad } from "../../wallet/arrival";
import type { WalletFeed } from "../../wallet/feed";

const HOME_ACTIVITY_ROWS = 3;

const selBalances = (f: WalletFeed) => f.balances;
const selAcc = (s: AccountsState) => s;
const selActivity = (s: ActivityState) => s;
const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });
const NO_ACTIVITY = new Store<ActivityState>({ items: [], refreshing: false, perpl: { state: "off", note: undefined }, meridian: { state: "off", note: undefined } });

function deployedVenues() {
  const cfg = getAppConfig();
  return { meridian: cfg.meridian.status === "deployed", perpl: cfg.perpl.status === "deployed" };
}

/** Wallet + venues for the hero and the breakdown sheet (one place, so the two can't disagree). */
function useHomeNumbers() {
  const balances = useWalletFeed(selBalances);
  const { accounts } = useTrade();
  const acc = useStore(accounts?.store ?? NO_ACC, selAcc);
  const deployed = deployedVenues();
  const walletWad = walletAusdWad(balances);
  const venues = venueEquities(acc, deployed);
  return { walletWad, venues, total: totalAusdWad({ walletWad, venues }), pnl: openPnl(acc, deployed), deployed, walletError: balances?.error };
}

function BreakdownRow({ label, value, why, testID }: { label: string; value: bigint | undefined; why?: string | undefined; testID: string }) {
  return (
    <View style={s.bRow}>
      <View style={s.grow}>
        <Text>{label}</Text>
        {why ? (
          <Text variant="caption" tone="muted" testID={`${testID}-why`}>
            {why}
          </Text>
        ) : null}
      </View>
      <Num value={value} kind="usd" label={`${label} in AUSD`} testID={testID} />
    </View>
  );
}

const Breakdown = memo(function Breakdown() {
  const n = useHomeNumbers();
  const missing = (["meridian", "perpl"] as const).filter((v) => !n.deployed[v]);
  return (
    <View style={s.breakdown} testID="home-breakdown">
      <BreakdownRow label="Wallet" value={n.walletWad} why={n.walletWad === undefined ? (n.walletError ? `Couldn't read it: ${n.walletError}` : "Reading…") : undefined} testID="breakdown-wallet" />
      {n.venues.map((v: VenueEquity) => (
        <BreakdownRow key={v.venue} label={`${VENUE_LABEL[v.venue]} account`} value={v.equityWad} why={v.why} testID={`breakdown-${v.venue}`} />
      ))}
      <View style={s.divider} />
      <BreakdownRow label="Total" value={n.total} testID="breakdown-total" />
      <Text variant="caption" tone="muted">
        Each account is valued the way its venue values it: what you deposited plus open profit or loss and funding.
        {missing.length ? ` ${missing.map((v) => VENUE_LABEL[v]).join(" and ")} isn't on this network yet.` : ""}
      </Text>
    </View>
  );
});

function Hero({ onBreakdown }: { onBreakdown: () => void }) {
  const n = useHomeNumbers();
  const shown = useCountUp(n.total);
  return (
    <Card style={s.hero}>
      <Text variant="caption" tone="muted">
        Total AUSD
      </Text>
      <Num value={shown} kind="usd" variant="hero" stale={Boolean(n.walletError)} label="Total AUSD" testID="home-total" />
      <View style={s.pnlRow}>
        <Text variant="caption" tone="muted">
          {n.venues.length ? "Wallet and trading accounts" : "In your wallet"}
        </Text>
        {n.pnl.open ? (
          <View style={s.pnl} testID="home-pnl-row">
            <Text variant="caption" tone="muted">
              Open PnL
            </Text>
            <Num value={n.pnl.pnlWad} kind="usd" signed variant="caption" label="Open profit or loss in AUSD" testID="home-pnl" />
          </View>
        ) : null}
      </View>
      <Button title="See breakdown" variant="link" onPress={onBreakdown} accessibilityHint="Wallet, Meridian and Perpl, one by one" testID="btn-home-breakdown" />
      <View style={s.actions}>
        <Button title="Trade" style={s.growBtn} onPress={() => router.navigate("/trade")} testID="btn-home-trade" />
        <Button title="Earn" variant="secondary" style={s.growBtn} onPress={() => router.navigate("/earn")} testID="btn-home-earn" />
      </View>
      <Button title="Add funds" variant="link" onPress={() => router.push("/fund")} testID="btn-home-add" />
      {n.total === 0n ? <EmptyState /> : null}
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

const RecentActivity = memo(function RecentActivity() {
  const { feed } = useActivity();
  const st = useStore(feed?.store ?? NO_ACTIVITY, selActivity);
  if (!feed) return null;
  return (
    <Card testID="home-activity">
      <View style={s.headRow}>
        <Text variant="caption" tone="muted">
          Activity
        </Text>
        <Button title="See all" variant="link" onPress={() => router.push("/activity")} accessibilityHint="Every deposit, trade and funding payment" testID="btn-home-activity" />
      </View>
      <ActivityList store={feed.store} limit={HOME_ACTIVITY_ROWS} />
      {st.items.length > HOME_ACTIVITY_ROWS ? (
        <Text variant="caption" tone="muted">
          {st.items.length - HOME_ACTIVITY_ROWS} more in Activity
        </Text>
      ) : null}
    </Card>
  );
});

/** expo-router error boundary for this tab only; the tab bar keeps working: calm screen, Retry + Home (features/shell/ErrorScreen). */
export { ErrorScreen as ErrorBoundary } from "../../features/shell/ErrorScreen";

export default function Home() {
  const { address } = useAccountAddress();
  const { accounts } = useTrade();
  const { feed } = useActivity();
  const refreshing = useStore(feed?.store ?? NO_ACTIVITY, (s: ActivityState) => s.refreshing);
  const sheet = useRef<SheetRef>(null);
  // positions + venue balances per block while Home is on top (the same reader the Trade screen uses)
  useAccountReadsWhileFocused();
  const earnPair = useEarnPair();
  useEffect(() => {
    void feed?.refresh();
  }, [feed]);
  const refresh = () => {
    accounts?.invalidate();
    void feed?.refresh();
  };
  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.text} colors={[colors.brand]} />}>
      <View style={s.top}>
        {address ? <WalletChip address={address} /> : <View />}
        <BlockPulse />
      </View>
      <Hero onBreakdown={() => sheet.current?.present()} />
      <PositionCards earnPair={earnPair} />
      <RecentActivity />
      <MarketHeader />
      <Sheet ref={sheet} title="Where your AUSD is">
        <Breakdown />
      </Sheet>
    </Screen>
  );
}

const s = StyleSheet.create({
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m, flexWrap: "wrap" },
  hero: { gap: space.s },
  pnlRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.s, flexWrap: "wrap" },
  pnl: { flexDirection: "row", alignItems: "center", gap: space.xs },
  actions: { flexDirection: "row", gap: space.m, marginTop: space.m, flexWrap: "wrap" },
  growBtn: { flexGrow: 1, flexBasis: 120 },
  grow: { flex: 1, gap: 2 },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  empty: { gap: space.s, marginTop: space.s, paddingTop: space.m, borderTopWidth: 1, borderTopColor: colors.border },
  breakdown: { gap: space.m },
  bRow: { flexDirection: "row", alignItems: "center", gap: space.m },
  divider: { height: 1, backgroundColor: colors.border },
});
