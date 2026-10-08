import { Stack } from "expo-router";
import { colors } from "../../ui";

export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "slide_from_right" }} />;
}
