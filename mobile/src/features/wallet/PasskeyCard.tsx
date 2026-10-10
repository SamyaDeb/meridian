// Settings passkey card (FIDO design principle 9, MOBILE_UX_RESEARCH §5.5 / L7): what the passkey is, where it lives and
// what signing out does — all visible text, nothing behind a tooltip. Android only (no iOS native build: MOBILE_PLAN §5,
// 8 Oct), so the provider is Google Password Manager.
import { StyleSheet, View } from "react-native";
import { Card, colors, PasskeyIcon, space, Text } from "../../ui";

export const PASSKEY_STATUS = "Passkey · Google Password Manager · active";
export const PASSKEY_WHERE = "Your passkey is saved in Google Password Manager on your Google account. A new phone signed in to the same account signs you back in. Meridian never sees it.";
export const PASSKEY_SIGN_OUT = "Signing out only forgets this wallet on this phone. Your passkey and your funds stay safe: sign back in with “Use an existing passkey”.";

export function PasskeyCard() {
  return (
    <Card testID="passkey-card">
      <View style={s.head}>
        <View style={s.symbol}>
          <PasskeyIcon color={colors.brandSoft} />
        </View>
        <Text bold style={s.grow}>
          {PASSKEY_STATUS}
        </Text>
      </View>
      <Text tone="muted">{PASSKEY_WHERE}</Text>
      <Text tone="muted">Only your fingerprint, face or screen lock can move your funds.</Text>
      <Text tone="muted">{PASSKEY_SIGN_OUT}</Text>
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.m },
  symbol: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" },
  grow: { flexShrink: 1 },
});
