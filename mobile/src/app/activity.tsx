// Activity (MOBILE_PLAN N7 §7): deposits, trades on both venues, funding, merged newest first; every row opens its
// receipt; pull to refresh reads every source again.
import { router } from "expo-router";
import { useEffect } from "react";
import { RefreshControl } from "react-native";
import { ActivityList } from "../features/activity/ActivityList";
import { useActivity } from "../features/activity/ActivityProvider";
import type { ActivityState } from "../features/activity/feed";
import { Screen } from "../features/shell/Screen";
import { Store, useStore } from "../live/store";
import { Button, Card, colors, Text } from "../ui";

const selRefreshing = (s: ActivityState) => s.refreshing;
const IDLE = new Store<ActivityState>({ items: [], refreshing: false, perpl: { state: "off", note: undefined }, meridian: { state: "off", note: undefined } });

export default function ActivityScreen() {
  const { feed } = useActivity();
  const refreshing = useStore(feed?.store ?? IDLE, selRefreshing);
  useEffect(() => {
    void feed?.refresh();
  }, [feed]);
  return (
    <Screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void feed?.refresh()} tintColor={colors.text} colors={[colors.brand]} />}
      footer={<Button title="Close" variant="secondary" onPress={() => router.back()} testID="activity-close" />}
    >
      <Text variant="title" accessibilityRole="header">
        Activity
      </Text>
      <Card>
        <ActivityList store={feed?.store} />
      </Card>
      <Button title="Refresh" variant="link" onPress={() => void feed?.refresh()} accessibilityHint="Reads your history again (or pull down)" testID="activity-refresh" />
    </Screen>
  );
}
