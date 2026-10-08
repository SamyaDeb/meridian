import { router } from "expo-router";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { Button, Text } from "../../ui";

export default function EnablePerpl() {
  return (
    <Screen footer={<Button title="Back" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Enable Perpl
      </Text>
      <Phase phase="N4" title="Three checks, resumable">
        Register a trading key, open your Perpl account with AUSD, and allow order forwarding. Each step resumes where it stopped.
      </Phase>
    </Screen>
  );
}
