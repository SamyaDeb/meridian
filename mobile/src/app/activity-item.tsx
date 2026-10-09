// One non-trade Activity row in full (deposit, withdrawal, funding, liquidation): what, where, when, how much, and the
// transaction on the explorer when there is one. Trades open the receipt instead.
import { router } from "expo-router";
import { Linking, StyleSheet, View } from "react-native";
import { activityItemStore } from "../features/activity/ActivityList";
import { whenText, type ActivityItem } from "../features/activity/model";
import { Screen } from "../features/shell/Screen";
import { useLive } from "../live/LiveProvider";
import { useStore } from "../live/store";
import { Button, Card, formatValue, space, Text } from "../ui";

const sel = (i: ActivityItem | undefined) => i;

function Row({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={s.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text tone="muted">{label}</Text>
      <Text bold style={s.num} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export default function ActivityItemModal() {
  const it = useStore(activityItemStore, sel);
  const explorer = useLive().config.chain.blockExplorers?.default.url;
  const close = () => {
    activityItemStore.set(undefined);
    router.back();
  };
  const url = it?.txHash && explorer ? `${explorer.replace(/\/+$/, "")}/tx/${it.txHash}` : undefined;
  return (
    <Screen footer={<Button title="Done" onPress={close} testID="activity-item-done" />}>
      <Text variant="title" accessibilityRole="header" testID="activity-item-title">
        {it?.title ?? "Activity"}
      </Text>
      {it ? (
        <Card>
          <Row label="Where" value={it.venue === "perpl" ? "Perpl" : it.venue === "meridian" ? "Meridian" : "Meridian + Perpl"} />
          <Row label="Amount" value={it.amountWad === undefined ? "—" : `${formatValue(it.amountWad, "usd", { signed: true })} AUSD`} testID="activity-item-amount" />
          <Row label="When" value={it.atMs !== undefined ? new Date(it.atMs).toLocaleString() : whenText(undefined, 0, it.block)} />
          {it.block !== undefined ? <Row label="Block" value={it.block.toString()} /> : null}
          {it.txHash ? <Row label="Transaction" value={`${it.txHash.slice(0, 10)}…${it.txHash.slice(-6)}`} /> : null}
          {url ? <Button title="View on the explorer" variant="link" onPress={() => void Linking.openURL(url)} /> : null}
        </Card>
      ) : (
        <Text tone="muted">Nothing selected.</Text>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m },
  num: { fontVariant: ["tabular-nums"] },
});
