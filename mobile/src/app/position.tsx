import { router } from "expo-router";
import { Phase } from "../features/shell/Phase";
import { Screen } from "../features/shell/Screen";
import { Button, Text } from "../ui";

export default function PositionModal() {
  return (
    <Screen footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Position
      </Text>
      <Phase phase="N7" title="Position detail">
        Live PnL, funding paid or earned, liquidation price and distance, with close, flip and add margin.
      </Phase>
    </Screen>
  );
}
