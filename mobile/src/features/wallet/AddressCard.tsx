// The wallet address with a copy button (expo-clipboard). The address is public; copying it is always fine.
import * as Clipboard from "expo-clipboard";
import { StyleSheet, View } from "react-native";
import { Button, Card, haptic, space, Text, useToast } from "../../ui";

export function AddressCard({ address, label = "Your address" }: { address: string; label?: string }) {
  const toast = useToast();
  return (
    <Card>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text selectable testID="wallet-address" accessibilityLabel={`${label}: ${address.split("").join(" ")}`} style={s.addr}>
        {address}
      </Text>
      <View style={s.row}>
        <Button
          title="Copy address"
          variant="secondary"
          onPress={() =>
            void Clipboard.setStringAsync(address).then(
              () => {
                haptic.selection();
                toast("Address copied", "success");
              },
              () => toast("Couldn't copy", "error"),
            )
          }
        />
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  addr: { fontVariant: ["tabular-nums"], fontFamily: "monospace" },
  row: { flexDirection: "row", gap: space.m, marginTop: space.s },
});
