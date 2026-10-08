import { MarketHeader } from "../../features/markets/MarketHeader";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { SpreadPanel } from "../../features/welcome/SpreadPanel";
import { Card, Text } from "../../ui";

export default function Earn() {
  return (
    <Screen>
      <Text variant="title" accessibilityRole="header">
        Earn
      </Text>
      <Card>
        <SpreadPanel />
      </Card>
      <MarketHeader />
      <Phase phase="N6" title="Earn the gap">
        Short the venue whose longs pay more, long the other, in one tap: the APR shown is net of both venues' fees, with an optional fixed-rate lock.
      </Phase>
    </Screen>
  );
}
