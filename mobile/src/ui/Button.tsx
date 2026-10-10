import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type PressableProps } from "react-native";
import { Text } from "./Text";
import { colors, HIT, radius, space } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "link";
export type ButtonProps = Omit<PressableProps, "children"> & {
  title: string;
  variant?: ButtonVariant;
  accessibilityHint?: string;
  /** decorative leading icon (hidden from screen readers; the title is the label) */
  icon?: ReactNode;
};

const TEXT_COLOR: Record<ButtonVariant, string | undefined> = { primary: colors.onBrand, secondary: undefined, ghost: undefined, link: colors.brandSoft };

export function Button({ title, variant = "primary", disabled, style, icon, ...rest }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={4}
      style={(state) => [s.base, s[variant], state.pressed && s.pressed, disabled && s.disabled, typeof style === "function" ? style(state) : style]}
      {...rest}
    >
      {icon ? <View style={s.icon}>{icon}</View> : null}
      <Text bold style={TEXT_COLOR[variant] ? { color: TEXT_COLOR[variant] } : null}>
        {title}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: { minHeight: HIT + 4, paddingHorizontal: space.xl, borderRadius: radius.control, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: space.s },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  ghost: { backgroundColor: "transparent" },
  link: { backgroundColor: "transparent", minHeight: HIT },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
  icon: { marginLeft: -space.xs },
});
