// Remote flags for the whole app (LAUNCH_PLAN §3.3): one FlagsClient (start, foreground, 60 s while active) under the live
// layer, so the forced-update screen can show before unlock. Open entry points ask `useOpenBlocked(kind)` (the same
// opensBlocked the order lock asks); closes never do.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { secureKv } from "../../auth/secureKv";
import { appVersion } from "../../config";
import { useLive } from "../../live/LiveProvider";
import { Store, useStore } from "../../live/store";
import { rnFetch } from "../../venues/perpl/runtime";
import { FlagsClient } from "./client";
import { INITIAL_VIEW, opensBlocked, type FlagsView, type OpenKind } from "./model";

/** No provider (unit tests of a single screen) ⇒ everything allowed. */
const FlagsContext = createContext<Store<FlagsView>>(new Store(INITIAL_VIEW));

export function FlagsProvider({ children, client: injected }: { children: ReactNode; client?: FlagsClient }) {
  const live = useLive();
  const [client] = useState(() => injected ?? new FlagsClient({ webUrl: live.config.webUrl, env: live.config.env, appVersion: appVersion(), fetch: rnFetch, kv: secureKv, appState: AppState }));
  useEffect(() => client.start(), [client]);
  return <FlagsContext.Provider value={client.store}>{children}</FlagsContext.Provider>;
}

export const useFlagsStore = (): Store<FlagsView> => useContext(FlagsContext);

const selView = (v: FlagsView) => v;
export const useFlags = (): FlagsView => useStore(useFlagsStore(), selView);

/** Why an open of `kind` is refused now, or undefined; re-renders when the flags change. */
export function useOpenBlocked(kind: OpenKind): string | undefined {
  return opensBlocked(kind, useFlags());
}
