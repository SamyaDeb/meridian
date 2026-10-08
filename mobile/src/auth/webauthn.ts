// Which WebAuthn client the app uses. Release builds: always react-native-passkey via Mera. The fake exists only when
// __DEV__ (Metro inlines false in release and drops the require) AND APP_ENV is development AND it is asked for
// with EXPO_PUBLIC_FAKE_PASSKEY=1 (emulator runs without a passkey provider). No biometric bypass in release.
import type { WebAuthnClient } from "@category-labs/mera";
import { reactNativeWebAuthnClient } from "@category-labs/mera/react-native-webauthn-client";
import type { AppEnv } from "../config/appConfig";

export function pickWebAuthnClient(env: AppEnv): { client: WebAuthnClient; fake: boolean } {
  if (__DEV__ && env === "development" && process.env.EXPO_PUBLIC_FAKE_PASSKEY === "1") {
    const { devFakeWebAuthnClient } = require("./fakeWebAuthn") as typeof import("./fakeWebAuthn");
    return { client: devFakeWebAuthnClient, fake: true };
  }
  return { client: reactNativeWebAuthnClient, fake: false };
}
