// Receipt (research §5.3, M4): explicit success right after the fill, with a success haptic: venue, average price,
// size, fee, order id / transaction link, blocks to fill. A failed order shows the reason in plain words.
import { router } from "expo-router";
import { useEffect } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Screen } from "../features/shell/Screen";
import { receiptStore, type Receipt } from "../features/trade/exec/receipt";
import { feeText, priceText, sizeText } from "../features/trade/ticket/quote";
import { useStore } from "../live/store";
import { Button, Card, colors, haptic, space, Text } from "../ui";

const sel = (r: Receipt | undefined) => r;

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

export default function ReceiptModal() {
  const r = useStore(receiptStore, sel);
  useEffect(() => {
    if (r?.ok) haptic.success();
    else if (r) haptic.error();
  }, [r]);
  const close = () => {
    receiptStore.set(undefined);
    router.back();
  };
  if (!r)
    return (
      <Screen footer={<Button title="Close" variant="secondary" onPress={close} />}>
        <Text variant="title" accessibilityRole="header">
          Receipt
        </Text>
        <Text tone="muted">No recent order.</Text>
      </Screen>
    );
  const action = r.reduceOnly ? "Closed" : r.side === "long" ? "Long opened" : "Short opened";
  return (
    <Screen footer={<Button title="Done" onPress={close} testID="receipt-done" />}>
      <View style={s.hero}>
        <View style={[s.badge, { backgroundColor: r.ok ? colors.long : colors.short }]}>
          <Text variant="title" bold style={{ color: colors.onBrand }}>
            {r.ok ? "✓" : "!"}
          </Text>
        </View>
        <Text variant="title" accessibilityRole="header" testID="receipt-title">
          {r.ok ? `${action} on ${r.venue === "perpl" ? "Perpl" : "Meridian"}` : "Order didn't fill"}
        </Text>
        <Text tone="muted" style={s.center}>
          {r.summary}
        </Text>
      </View>
      {r.ok ? (
        <Card>
          <Row label="Filled" value={`${sizeText(r.filledWad, r.stepWad)} MON`} testID="receipt-size" />
          <Row label="Average price" value={priceText(r.avgPriceWad, r.priceDp)} testID="receipt-avg" />
          <Row label="Fee" value={r.feeWad === undefined ? "—" : feeText(r.feeWad)} testID="receipt-fee" />
          <Row label="Blocks to fill" value={r.blocksToFill === undefined ? "—" : r.blocksToFill.toString()} testID="receipt-blocks" />
          {r.orderId !== undefined ? <Row label="Perpl order" value={`#${r.orderId}`} testID="receipt-order" /> : null}
          {r.txHash ? <Row label="Transaction" value={`${r.txHash.slice(0, 10)}…${r.txHash.slice(-6)}`} testID="receipt-tx" /> : null}
          {r.explorerTxUrl ? <Button title="View on the explorer" variant="link" onPress={() => void Linking.openURL(r.explorerTxUrl!)} testID="receipt-explorer" /> : null}
        </Card>
      ) : (
        <Card>
          <Text tone="short" accessibilityRole="alert" testID="receipt-error">
            {r.error}
          </Text>
          <Text variant="caption" tone="muted">
            Nothing filled, so nothing changed on your account.
          </Text>
        </Card>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: "center", gap: space.s, paddingVertical: space.l },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  center: { textAlign: "center" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.m },
  num: { fontVariant: ["tabular-nums"] },
});
