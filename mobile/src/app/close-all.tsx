import { router } from "expo-router";
import { Phase } from "../features/shell/Phase";
import { Screen } from "../features/shell/Screen";
import { Button, Text } from "../ui";

export default function CloseallModal() {
  return (
    <Screen footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text variant="title" accessibilityRole="header">
        Close all
      </Text>
      <Phase phase="N7" title="Close everything">
        Closes every position on both venues, Meridian first, then Perpl for exactly what closed.
      </Phase>
    </Screen>
  );
}
