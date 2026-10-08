import { Pressable, StyleSheet, type PressableProps } from "react-native";
import { Text } from "./Text";
import { colors, HIT, radius, space } from "./tokens";

export type ButtonProps = Omit<PressableProps, "children"> & { title: string; variant?: "primary" | "secondary" | "ghost"; accessibilityHint?: string };

export function Button({ title, variant = "primary", disabled, style, ...rest }: ButtonProps) {
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
      <Text bold style={variant === "primary" ? { color: colors.onBrand } : null}>
        {title}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: { minHeight: HIT + 4, paddingHorizontal: space.xl, borderRadius: radius.control, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  ghost: { backgroundColor: "transparent" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});
