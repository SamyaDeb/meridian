import { StyleSheet, View, type ViewProps } from "react-native";
import { colors, radius, space } from "./tokens";

export function Card({ style, ...rest }: ViewProps) {
  return <View {...rest} style={[s.card, style]} />;
}

const s = StyleSheet.create({ card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: space.l, gap: space.m } });
