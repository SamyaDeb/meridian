import { router } from "expo-router";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { Button, Text } from "../../ui";

export default function Create() {
  return (
    <Screen footer={<Button title="Back" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Your wallet
      </Text>
      <Phase phase="N3" title="Face ID wallet">
        Create or unlock a passkey wallet with Face ID or your fingerprint. The same passkey gives the same address on the web app.
      </Phase>
    </Screen>
  );
}
