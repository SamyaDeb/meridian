import { Tabs } from "expo-router";
import { TABS } from "../../features/shell/tabs";
import { colors, TabIcon } from "../../ui";

export const unstable_settings = { initialRouteName: "portfolio" };

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="portfolio"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 12 },
        sceneStyle: { backgroundColor: colors.bg },
        animation: "fade",
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title, tabBarAccessibilityLabel: `${t.title} tab`, tabBarButtonTestID: `tab-${t.name}`, tabBarIcon: ({ color }) => <TabIcon name={t.name} color={color} /> }} />
      ))}
    </Tabs>
  );
}
