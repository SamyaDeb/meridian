// Earn tab (MOBILE_PLAN N6): the two-leg funding-gap trade. Everything lives in features/earn.
import { EarnScreen } from "../../features/earn/EarnScreen";
import { Screen } from "../../features/shell/Screen";

/** expo-router error boundary for this tab only; the tab bar keeps working: calm screen, Retry + Home (features/shell/ErrorScreen). */
export { ErrorScreen as ErrorBoundary } from "../../features/shell/ErrorScreen";

export default function Earn() {
  return (
    <Screen>
      <EarnScreen />
    </Screen>
  );
}
