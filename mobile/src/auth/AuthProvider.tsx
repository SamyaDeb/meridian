// Mounts one AuthController for the app: loads the credential record, feeds AppState + touches into the lock timers.
// Children read status/address through hooks; the signer stays inside the controller.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { getAppConfig } from "../config";
import { Store, useStore } from "../live/store";
import { AuthController } from "./controller";
import { secureKv } from "./secureKv";
import { DEV_BACKGROUND_LOCK_MS, DEV_IDLE_LOCK_MS, type AuthState } from "./session";
import { pickWebAuthnClient } from "./webauthn";

const AuthContext = createContext<AuthController | undefined>(undefined);

function createAppController(): AuthController {
  const cfg = getAppConfig();
  const short = __DEV__ && process.env.EXPO_PUBLIC_SHORT_LOCK === "1";
  return new AuthController({
    cfg: { env: cfg.env, rpId: cfg.rpId, androidPackage: cfg.androidPackage },
    kv: secureKv,
    webAuthnClient: pickWebAuthnClient(cfg.env).client,
    ...(short ? { idleMs: DEV_IDLE_LOCK_MS, backgroundMs: DEV_BACKGROUND_LOCK_MS } : {}),
  });
}

export function AuthProvider({ children, controller }: { children: ReactNode; controller?: AuthController }) {
  const [auth] = useState<AuthController>(() => controller ?? createAppController());

  useEffect(() => {
    void auth.init().catch(() => undefined);
    const sub = AppState.addEventListener("change", (s) => auth.onAppState(s));
    return () => {
      sub.remove();
      auth.lock();
    };
  }, [auth]);

  return (
    <AuthContext.Provider value={auth}>
      {/* capture-phase observer: every touch anywhere is activity for the idle lock; never claims the responder */}
      <View style={{ flex: 1 }} onStartShouldSetResponderCapture={() => (auth.touch(), false)}>
        {children}
      </View>
    </AuthContext.Provider>
  );
}

export function useAuthController(): AuthController {
  const a = useContext(AuthContext);
  if (!a) throw new Error("useAuthController outside <AuthProvider>");
  return a;
}

const EMPTY = new Store<AuthState>({ status: "loading" });
const selStatus = (s: AuthState) => s.status;
const selSelf = (s: AuthState) => s;

export const useAuthStatus = (): AuthState["status"] => useStore(useContext(AuthContext)?.store ?? EMPTY, selStatus);
export const useAuthState = (): AuthState => useStore(useContext(AuthContext)?.store ?? EMPTY, selSelf);

/** Address when unlocked; the public hint when locked with an account; undefined otherwise. */
export function useAccountAddress(): { address: `0x${string}` | undefined; locked: boolean } {
  const s = useAuthState();
  if (s.status === "unlocked") return { address: s.address, locked: false };
  if (s.status === "locked" || s.status === "unlocking") return { address: s.addressHint, locked: true };
  return { address: undefined, locked: true };
}

const selDerive = (s: { deriveMs: number | undefined }) => s.deriveMs;
export const useDeriveMs = (): number | undefined => useStore(useAuthController().stats, selDerive);
