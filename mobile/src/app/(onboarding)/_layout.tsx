import { Stack } from "expo-router";
import { useAuthStatus } from "../../auth/AuthProvider";
import { colors } from "../../ui";

export default function OnboardingLayout() {
  const unlocked = useAuthStatus() === "unlocked";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="create" />
      <Stack.Screen name="unlock" />
      <Stack.Protected guard={unlocked}>
        <Stack.Screen name="perpl" />
      </Stack.Protected>
    </Stack>
  );
}
