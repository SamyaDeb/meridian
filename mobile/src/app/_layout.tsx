import "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuthStatus } from "../auth/AuthProvider";
import { LiveProvider } from "../live/LiveProvider";
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
        {["route", "receipt", "position", "close-all", "recovery"].map((name) => (
          <Stack.Screen key={name} name={name} options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        ))}
      </Stack.Protected>
      <Stack.Screen name="dev/smoke" options={{ headerShown: true, title: "Hermes smoke", headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text }} />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <LiveProvider>
            <AuthProvider>
            <BottomSheetModalProvider>
              <ToastProvider>
                <StatusBar style="light" />
                <RootStack />
                <OfflineBanner />
              </ToastProvider>
            </BottomSheetModalProvider>
            </AuthProvider>
          </LiveProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
