import { Tabs } from "expo-router";
import { colors, TabIcon, type TabIconName } from "../../ui";

const TABS: { name: TabIconName; title: string }[] = [
  { name: "trade", title: "Trade" },
  { name: "earn", title: "Earn" },
  { name: "portfolio", title: "Portfolio" },
  { name: "settings", title: "Settings" },
];

export default function TabsLayout() {
  return (
    <Tabs
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
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title, tabBarAccessibilityLabel: `${t.title} tab`, tabBarIcon: ({ color }) => <TabIcon name={t.name} color={color} /> }} />
      ))}
    </Tabs>
  );
}
