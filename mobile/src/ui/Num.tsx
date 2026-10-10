// Numbers: tabular figures (no jitter as they tick), sign + colour for signed values (never colour alone), "—" for
// unknown, dimmed + labelled when stale. Never truncates: wraps at large font scales instead of clipping.
import { memo } from "react";
import { formatValue, spokenValue, type NumKind } from "./format";
import { Text, type TextTone, type TextVariant } from "./Text";

export type NumProps = {
  value: bigint | undefined;
  kind: NumKind;
  dp?: number;
  /** show "+" and colour by sign (long = positive, short = negative) */
  signed?: boolean;
  /** invert the colour meaning (e.g. funding you pay: positive is bad) */
  invertTone?: boolean;
  stale?: boolean;
  variant?: TextVariant;
  tone?: TextTone;
  label?: string;
  testID?: string;
};

export const Num = memo(function Num({ value, kind, dp, signed, invertTone, stale, variant = "body", tone, label, testID }: NumProps) {
  const text = formatValue(value, kind, { ...(dp !== undefined ? { dp } : {}), signed: signed ?? false });
  let t: TextTone = tone ?? "text";
  if (signed && value !== undefined && value !== 0n) t = value > 0n !== Boolean(invertTone) ? "long" : "short";
  if (value === undefined || stale) t = "muted";
  const a11y = `${label ? `${label}: ` : ""}${spokenValue(text)}${stale ? ", stale" : ""}`;
  return (
    <Text variant={variant} tone={t} bold={variant !== "caption"} style={{ fontVariant: ["tabular-nums"] }} accessibilityLabel={a11y} testID={testID}>
      {text}
      {stale && value !== undefined ? <Text variant="caption" tone="warn"> stale</Text> : null}
    </Text>
  );
});
