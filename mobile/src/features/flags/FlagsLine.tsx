// The one line an open entry point shows about the flags: why opens are refused (kill switch / forced update), or on
// production with no usable flags the small "Can't check service status" note. Nothing when all is well.
import { Text } from "../../ui";
import { useFlags } from "./FlagsProvider";
import { opensBlocked, type OpenKind } from "./model";

export function FlagsLine({ kind, testID = "flags-line" }: { kind: OpenKind; testID?: string }) {
  const v = useFlags();
  const why = opensBlocked(kind, v);
  if (why)
    return (
      <Text tone="warn" accessibilityRole="alert" testID={testID}>
        {why}
      </Text>
    );
  if (v.statusLine)
    return (
      <Text variant="caption" tone="muted" testID={`${testID}-status`}>
        {v.statusLine}
      </Text>
    );
  return null;
}
