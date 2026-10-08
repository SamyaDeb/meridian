import { MarketHeader } from "../../features/markets/MarketHeader";
import { Phase } from "../../features/shell/Phase";
import { Screen } from "../../features/shell/Screen";
import { Text } from "../../ui";

export default function Portfolio() {
  return (
    <Screen>
      <Text variant="title" accessibilityRole="header">
        Portfolio
      </Text>
      <MarketHeader />
      <Phase phase="N7" title="Everything you hold, live">
        Total AUSD across your wallet and both venues, positions with live PnL and liquidation distance, funding earned, and history.
      </Phase>
    </Screen>
  );
}
