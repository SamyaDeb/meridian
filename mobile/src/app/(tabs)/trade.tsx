import { router } from "expo-router";
import { useRef } from "react";
import { MarketHeader } from "../../features/markets/MarketHeader";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { Button, HoldButton, Sheet, Text, useToast, type SheetRef } from "../../ui";

export default function Trade() {
  const sheet = useRef<SheetRef>(null);
  const toast = useToast();
  return (
    <Screen footer={<Button title="Compare both books" variant="secondary" onPress={() => sheet.current?.present()} />}>
      <Text variant="title" accessibilityRole="header">
        Trade
      </Text>
      <MarketHeader />
      <Phase phase="N5" title="One ticket, best venue">
        Enter AUSD, pick long or short and leverage; the app quotes both books every block and routes to the better price. Hold to confirm, then Face ID.
      </Phase>
      <Button title="Open route details" variant="ghost" onPress={() => router.push("/route")} />
      <Sheet ref={sheet} title="Both books">
        <MarketHeader />
        {__DEV__ ? (
          // UI check for the dev build only: nothing is sent
          <HoldButton title="Hold to confirm (UI test)" onConfirm={() => toast("Hold complete. Nothing was sent: UI test only.", "success")} />
        ) : null}
      </Sheet>
    </Screen>
  );
}
