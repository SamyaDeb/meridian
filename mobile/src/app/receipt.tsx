import { router } from "expo-router";
import { Phase } from "../features/shell/Phase";
import { Screen } from "../features/shell/Screen";
import { Button, Text } from "../ui";

export default function ReceiptModal() {
  return (
    <Screen footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Receipt
      </Text>
      <Phase phase="N5" title="Your fill">
        Venue, average price, size, fee and links to the transaction or Perpl order, right after it fills.
      </Phase>
    </Screen>
  );
}
