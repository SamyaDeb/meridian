// The fake WebAuthn client must never ship: it is reachable only through a `__DEV__ && …` guarded require in
// src/auth/webauthn.ts (Metro inlines __DEV__ = false in release and drops the branch). The bundle itself is checked by
// `pnpm --filter @meridian/mobile check:release` (exports a production bundle and greps for FAKE_WEBAUTHN_MARKER).
import { fs, path, sourceFiles, SRC_DIR } from "../node";
import { pickWebAuthnClient } from "../../auth/webauthn";
import { reactNativeWebAuthnClient } from "@category-labs/mera/react-native-webauthn-client";


it("fakeWebAuthn is referenced only from webauthn.ts, inside a __DEV__ && development guard, never statically imported", () => {
  const refs = sourceFiles().filter((f) => !f.endsWith("fakeWebAuthn.ts") && /fakeWebAuthn/.test(fs.readFileSync(f, "utf8")));
  expect(refs.map((f) => f.slice(SRC_DIR.length + 1))).toEqual([path.join("auth", "webauthn.ts")]);
  const src = fs.readFileSync(path.join(SRC_DIR, "auth", "webauthn.ts"), "utf8");
  expect(src).not.toMatch(/^import[^\n]*fakeWebAuthn/m);
  expect(src).toMatch(/if \(__DEV__ && env === "development" && process\.env\.EXPO_PUBLIC_FAKE_PASSKEY === "1"\) \{\n\s+const \{ devFakeWebAuthnClient \} = require\("\.\/fakeWebAuthn"\)/);
});

it("staging and production always get the real client; development only with the explicit flag", () => {
  expect(pickWebAuthnClient("staging")).toEqual({ client: reactNativeWebAuthnClient, fake: false });
  expect(pickWebAuthnClient("production")).toEqual({ client: reactNativeWebAuthnClient, fake: false });
  expect(pickWebAuthnClient("development").fake).toBe(false);
});
