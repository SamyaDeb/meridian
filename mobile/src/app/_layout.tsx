import "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveProvider } from "../live/LiveProvider";
import { colors, OfflineBanner, ToastProvider } from "../ui";

void SplashScreen.preventAutoHideAsync();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.bg, card: colors.card, border: colors.border, text: colors.text, primary: colors.brand } };

export default function RootLayout() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <LiveProvider>
            <BottomSheetModalProvider>
              <ToastProvider>
                <StatusBar style="light" />
                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "fade" }}>
                  <Stack.Screen name="(onboarding)" />
                  <Stack.Screen name="(tabs)" />
                  {["route", "receipt", "position", "close-all"].map((name) => (
                    <Stack.Screen key={name} name={name} options={{ presentation: "modal", animation: "slide_from_bottom" }} />
                  ))}
                  <Stack.Screen name="dev/smoke" options={{ headerShown: true, title: "Hermes smoke", headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.text }} />
                </Stack>
                <OfflineBanner />
              </ToastProvider>
            </BottomSheetModalProvider>
          </LiveProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
