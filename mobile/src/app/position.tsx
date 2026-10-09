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
      <Phase phase="a later build" title="Flip and add margin">
        Flip a position in one step and add margin to move its liquidation price. Until then, live PnL, funding, the liquidation meter and Close are on each position card (Home and Trade), and Close all closes everything.
      </Phase>
    </Screen>
  );
}
