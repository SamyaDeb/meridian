// Runs one passkey action from a screen: busy flag, plain-language error line, haptics (DESIGN.md: success on
// create / sign-in, error on failure). A SESSION_ENDED error stays silent (the next action re-prompts). A cancelled OS
// sheet is the user's own choice: no error haptic, and screens show a calm line instead of red (MOBILE_UX_RESEARCH §5.1).
import { useCallback, useState } from "react";
import { useAuthController } from "../../auth/AuthProvider";
import type { AuthErrorKind } from "../../auth/errors";
import { haptic } from "../../ui";

export function useAuthAction() {
  const auth = useAuthController();
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorKind, setErrorKind] = useState<AuthErrorKind | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: () => Promise<void>, onDone?: () => void) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      setErrorKind(undefined);
      try {
        await action();
        haptic.success();
        onDone?.();
      } catch (e) {
        const d = auth.describe(e);
        if (d.kind !== "session-ended") {
          setError(d.message);
          setErrorKind(d.kind);
          if (d.kind !== "cancelled") haptic.error();
        }
      } finally {
        setBusy(false);
      }
    },
    [auth, busy],
  );
  return { run, error, errorKind, busy, auth };
}
