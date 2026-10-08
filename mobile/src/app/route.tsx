import { router } from "expo-router";
import { MarketHeader } from "../features/markets/MarketHeader";
import { Phase } from "../features/shell/Phase";
import { Screen } from "../features/shell/Screen";
import { Button, Text } from "../ui";

export default function RouteModal() {
  return (
    <Screen footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Route
      </Text>
      <MarketHeader />
      <Phase phase="N5" title="Where your order fills">
        Both books level by level, the levels your order would take highlighted, and the effective price on each venue after fees.
      </Phase>
    </Screen>
  );
}
