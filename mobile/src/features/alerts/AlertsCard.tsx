// Settings → Alerts: off by default, each one a switch with its rule in plain words. In-app only in this build (no
// phone notifications, so no notification permission is asked).
import { Switch, StyleSheet, View } from "react-native";
import { Store, useStore } from "../../live/store";
import { Card, colors, HIT, space, Text } from "../../ui";
import { useAlertSettings } from "./AlertsProvider";
import { NO_ALERTS, type AlertPrefs } from "./rules";

const OFF = new Store<AlertPrefs>(NO_ALERTS);
const sel = (p: AlertPrefs) => p;

export const ALERTS_SCOPE = "Shown in the app while Meridian is open. Phone notifications aren't in this build yet.";

function Toggle({ title, detail, value, onChange, testID }: { title: string; detail: string; value: boolean; onChange: (v: boolean) => void; testID: string }) {
  return (
    <View style={s.row}>
      <View style={s.grow}>
        <Text>{title}</Text>
        <Text variant="caption" tone="muted">
          {detail}
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} accessibilityHint={detail} trackColor={{ true: colors.brand, false: colors.border }} testID={testID} />
    </View>
  );
}

export function AlertsCard() {
  const settings = useAlertSettings();
  const p = useStore(settings?.store ?? OFF, sel);
  if (!settings) return null;
  return (
    <Card testID="alerts-card">
      <Text bold>Alerts</Text>
      <Toggle title="Close to liquidation" detail="When a position is less than 5% from its liquidation price." value={p.liq} onChange={(v) => void settings.set({ liq: v })} testID="alert-liq" />
      <Toggle title="Funding flips" detail="When longs and shorts swap who pays funding on Meridian or Perpl." value={p.funding} onChange={(v) => void settings.set({ funding: v })} testID="alert-funding" />
      <Text variant="caption" tone="muted">
        {ALERTS_SCOPE}
      </Text>
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: HIT },
  grow: { flex: 1, gap: 2 },
});
