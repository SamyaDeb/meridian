// Which chain the app talks to, and whether it's on viem's public RPC (rate-limited; development builds only).
import { StyleSheet, View } from "react-native";
import { getAppConfig } from "../config";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export function NetworkBadge() {
  const c = getAppConfig();
  const name = c.chainId === 143 ? "Monad" : "Monad testnet";
  const pub = c.rpc?.isPublic === true;
  const label = `${name}${pub ? ", public RPC" : ""}${c.rpc ? "" : ", no RPC configured"}`;
  return (
    <View style={s.row} accessible accessibilityLabel={`Network: ${label}`}>
      <View style={[s.pill, c.chainId !== 143 && s.test]}>
        <Text variant="caption" bold tone={c.chainId === 143 ? "text" : "warn"}>
          {name}
        </Text>
      </View>
      {pub ? (
        <View style={[s.pill, s.test]}>
          <Text variant="caption" tone="warn">
            Public RPC
          </Text>
        </View>
      ) : null}
      {!c.rpc ? (
        <View style={[s.pill, s.test]}>
          <Text variant="caption" tone="warn">
            No RPC
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", gap: space.xs, flexWrap: "wrap" },
  pill: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.s, paddingVertical: 2 },
  test: { borderColor: colors.warn },
});
