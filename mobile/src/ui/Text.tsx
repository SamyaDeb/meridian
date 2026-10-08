import { Text as RNText, type TextProps, type TextStyle } from "react-native";
import { colors, type as size, weight } from "./tokens";

export type TextVariant = "hero" | "title" | "body" | "caption";
export type TextTone = "text" | "muted" | "brand" | "long" | "short" | "warn";

export type AppTextProps = TextProps & { variant?: TextVariant; tone?: TextTone; bold?: boolean };

const base: Record<TextVariant, TextStyle> = {
  hero: { fontSize: size.hero, lineHeight: 40, fontWeight: weight.semibold },
  title: { fontSize: size.title, lineHeight: 26, fontWeight: weight.semibold },
  body: { fontSize: size.body, lineHeight: 21, fontWeight: weight.regular },
  caption: { fontSize: size.caption, lineHeight: 16, fontWeight: weight.regular },
};

/** The only text primitive: four sizes, two weights, font scaling on. */
export function Text({ variant = "body", tone = "text", bold, style, ...rest }: AppTextProps) {
  return <RNText allowFontScaling {...rest} style={[base[variant], { color: colors[tone] }, bold ? { fontWeight: weight.semibold } : null, style]} />;
}
