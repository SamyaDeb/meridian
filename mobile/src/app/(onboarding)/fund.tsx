import { router } from "expo-router";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { Button, Text } from "../../ui";

export default function Fund() {
  return (
    <Screen footer={<Button title="Back" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Add AUSD
      </Text>
      <Phase phase="N3" title="Deposit address">
        Your AUSD and MON address with a QR code, and your balance updating live as funds arrive.
      </Phase>
    </Screen>
  );
}
