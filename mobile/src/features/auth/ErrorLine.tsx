import type { AuthErrorKind } from "../../auth/errors";
import { Text } from "../../ui";

/** The result line under a passkey action. `calm` replaces the message when the user cancelled the OS sheet: muted,
 *  no alert role (nothing went wrong). */
export function ErrorLine({ message, kind, calm }: { message: string | undefined; kind?: AuthErrorKind | undefined; calm?: string }) {
  if (!message) return null;
  if (kind === "cancelled" && calm)
    return (
      <Text tone="muted" accessibilityLiveRegion="polite" testID="auth-calm">
        {calm}
      </Text>
    );
  return (
    <Text tone="short" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="auth-error">
      {message}
    </Text>
  );
}
