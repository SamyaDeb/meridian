// Wallet identity as people see it: identicon + "Wallet ••a3f2" (never the hex; the full address lives in the
// Add funds / copy sheet only).
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { colors, space, Text } from "../../ui";
import { identicon, IDENTICON_SIZE, walletLabel, walletSpoken } from "../../wallet/identity";

export const Identicon = memo(function Identicon({ address, size = 32 }: { address: string; size?: number }) {
  const { cells, color } = identicon(address);
  const cell = size / (IDENTICON_SIZE + 1);
  const pad = cell / 2;
  return (
    <View style={[s.frame, { width: size, height: size, borderRadius: size / 4 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="identicon">
      <Svg width={size} height={size}>
        {cells.map((on, i) =>
          on ? <Rect key={i} x={pad + (i % IDENTICON_SIZE) * cell} y={pad + Math.floor(i / IDENTICON_SIZE) * cell} width={cell} height={cell} fill={color} /> : null,
        )}
      </Svg>
    </View>
  );
});

export function WalletChip({ address, size = 32, caption }: { address: string; size?: number; caption?: string }) {
  return (
    <View style={s.row} accessible accessibilityRole="text" accessibilityLabel={`${walletSpoken(address)}${caption ? `. ${caption}` : ""}`} testID="wallet-chip">
      <Identicon address={address} size={size} />
      <View style={s.text}>
        <Text bold style={{ fontVariant: ["tabular-nums"] }}>
          {walletLabel(address)}
        </Text>
        {caption ? (
          <Text variant="caption" tone="muted">
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  frame: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: 44 },
  text: { flexShrink: 1, gap: 2 },
});
