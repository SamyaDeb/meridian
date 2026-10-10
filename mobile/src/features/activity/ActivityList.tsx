// Activity rows (research §5.2): what happened, where, when, how much; every row is one tap to its receipt (trades) or
// its detail (deposits, funding, liquidations). Sources that are off or failed say so under the list.
import { router } from "expo-router";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Store, useStore } from "../../live/store";
import { HIT, Num, space, Text } from "../../ui";
import { earnReceiptStore } from "../earn/executor";
import { receiptStore } from "../trade/exec/receipt";
import type { ActivityState } from "./feed";
import { whenText, type ActivityItem } from "./model";

/** The row the detail modal shows (app-wide, like receiptStore). */
export const activityItemStore = new Store<ActivityItem | undefined>(undefined);

export function openActivity(it: ActivityItem): void {
  if (it.earn) {
    earnReceiptStore.set(it.earn);
    router.push("/earn-receipt");
  } else if (it.receipt) {
    receiptStore.set(it.receipt);
    router.push("/receipt");
  } else {
    activityItemStore.set(it);
    router.push("/activity-item");
  }
}

const VENUE = { meridian: "Meridian", perpl: "Perpl", both: "Meridian + Perpl" } as const;

export const ActivityRow = memo(function ActivityRow({ it, nowMs }: { it: ActivityItem; nowMs: number }) {
  const when = whenText(it.atMs, nowMs, it.block);
  return (
    <Pressable onPress={() => openActivity(it)} accessibilityRole="button" accessibilityLabel={`${it.title} on ${VENUE[it.venue]}, ${when}`} accessibilityHint={it.receipt || it.earn ? "Opens the receipt" : "Opens the details"} style={({ pressed }) => [s.row, pressed && s.pressed]} testID={`activity-${it.id}`}>
      <View style={s.grow}>
        <Text bold numberOfLines={1}>
          {it.title}
        </Text>
        <Text variant="caption" tone="muted">
          {it.detail ? `${it.detail} · ` : ""}
          {VENUE[it.venue]} · {when}
        </Text>
      </View>
      {it.amountWad !== undefined ? <Num value={it.amountWad} kind="usd" signed label="Amount in AUSD" /> : <Text tone="muted">›</Text>}
    </Pressable>
  );
});

const selState = (s: ActivityState) => s;
const EMPTY = new Store<ActivityState>({ items: [], refreshing: false, perpl: { state: "off", note: undefined }, meridian: { state: "off", note: undefined } });

/** `limit` rows (Home shows a few, the Activity screen all of them). */
export function ActivityList({ store, limit, nowMs = Date.now() }: { store: Store<ActivityState> | undefined; limit?: number; nowMs?: number }) {
  const st = useStore(store ?? EMPTY, selState);
  const items = limit !== undefined ? st.items.slice(0, limit) : st.items;
  const notes = [st.perpl.note, st.meridian.note].filter((n): n is string => n !== undefined);
  return (
    <View style={s.list} testID="activity-list">
      {items.length === 0 ? (
        <Text tone="muted" testID="activity-empty">
          {st.refreshing ? "Loading your activity…" : "Nothing yet. Deposits, trades and funding show up here."}
        </Text>
      ) : (
        items.map((it) => <ActivityRow key={it.id} it={it} nowMs={nowMs} />)
      )}
      {limit === undefined
        ? notes.map((n) => (
            <Text key={n} variant="caption" tone={n.includes("didn't load") ? "warn" : "muted"} testID="activity-note">
              {n}
            </Text>
          ))
        : null}
    </View>
  );
}

const s = StyleSheet.create({
  list: { gap: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: HIT, paddingVertical: space.s },
  pressed: { opacity: 0.6 },
  grow: { flex: 1, gap: 2 },
});
