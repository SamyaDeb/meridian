import "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuthStatus } from "../auth/AuthProvider";
import { ActivityProvider } from "../features/activity/ActivityProvider";
import { AlertsProvider } from "../features/alerts/AlertsProvider";
import { EarnProvider } from "../features/earn/EarnProvider";
import { FlagsProvider } from "../features/flags/FlagsProvider";
import { UpdateGate } from "../features/flags/UpdateGate";
import { NotLiveGate } from "../features/shell/NotLive";
import { TradeProvider } from "../features/trade/TradeProvider";
import { WalletFeedProvider } from "../features/wallet/WalletFeedProvider";
import { LiveProvider } from "../live/LiveProvider";
import { PerplProvider } from "../venues/perpl/PerplProvider";
import { colors, OfflineBanner, ToastProvider } from "../ui";

void SplashScreen.preventAutoHideAsync();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg, card: colors.card, border: colors.border, text: colors.text, primary: colors.brand } };

/** Auth gate: tabs and wallet modals exist only while UNLOCKED. Locking (idle, background, manual) or a deep link while
 *  locked lands on the anchor route (index), which sends the user to Unlock / Welcome. */
function RootStack() {
  const unlocked = useAuthStatus() === "unlocked";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "fade" }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(onboarding)" />
      <Stack.Protected guard={unlocked}>
        <Stack.Screen name="(tabs)" />
        {["fund", "route", "receipt", "earn-receipt", "position", "close-all", "recovery", "activity", "activity-item"].map((name) => (
          <Stack.Screen key={name} name={name} options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        ))}
      </Stack.Protected>
      <Stack.Screen name="dev/smoke" options={{ headerShown: true, title: "Hermes smoke", headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text }} />
      <Stack.Screen name="dev/perpl" options={{ headerShown: true, title: "Perpl trade smoke", headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text }} />
    </Stack>
  );
}

/** expo-router error boundary for the whole app (also a provider that throws): calm screen, Retry + Home (features/shell/ErrorScreen). */
export { ErrorScreen as ErrorBoundary } from "../features/shell/ErrorScreen";

export default function RootLayout() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <LiveProvider>
            {/* remote flags (kill switches, forced update): read before unlock, so an old build shows the update screen */}
            <FlagsProvider>
              <AuthProvider>
                <PerplProvider>
                  <ToastProvider>
                    <WalletFeedProvider>
                      {/* sheets render through a portal at BottomSheetModalProvider: every context a sheet's content uses
                          (toast, wallet feed, activity, trade, earn) must sit ABOVE it */}
                      <ActivityProvider>
                        <TradeProvider>
                          <EarnProvider>
                            <AlertsProvider>
                              <BottomSheetModalProvider>
                                <StatusBar style="light" />
                                <UpdateGate>
                                  {/* production before N9 (no deployments/143.json): the calm "not live on mainnet yet" */}
                                  <NotLiveGate>
                                    <RootStack />
                                  </NotLiveGate>
                                </UpdateGate>
                              </BottomSheetModalProvider>
                            </AlertsProvider>
                          </EarnProvider>
                        </TradeProvider>
                      </ActivityProvider>
                    </WalletFeedProvider>
                    <OfflineBanner />
                  </ToastProvider>
                </PerplProvider>
              </AuthProvider>
            </FlagsProvider>
          </LiveProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
