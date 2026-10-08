// DEV/TEST ONLY fake WebAuthn client (Mera's WebAuthnClient interface). Reached in the app only through
// `__DEV__ && APP_ENV === "development"` in webauthn.ts, which Metro drops from release bundles
// (test: releaseExclusion.test.ts). PRF = keccak256(deviceSecret ‖ credentialId ‖ salt): deterministic per credential,
// like a real authenticator (not a real PRF construction; a fake only). The device secret is random per process unless
// a test passes a seed.
import type { WebAuthnClient } from "@category-labs/mera";
import { concat, keccak256, stringToBytes } from "viem";

const h = (...parts: Uint8Array[]): Uint8Array => keccak256(concat(parts), "bytes");

export const FAKE_WEBAUTHN_MARKER = "meridian-fake-webauthn-client";

export type FakeFailure = { error: string; message: string };

export type FakeWebAuthnOptions = {
  /** derive the device secret from this string (tests); default: random */
  seed?: string;
  /** reject the next ceremonies with these native-shaped errors (react-native-passkey { error, message }) */
  failNext?: FakeFailure[];
  /** authenticator without PRF */
  noPrf?: boolean;
};

export type FakeWebAuthn = WebAuthnClient & {
  calls: { create: number; get: number };
  failNext: FakeFailure[];
  /** credential ids this fake "device" holds */
  credentials: Uint8Array[];
};

export function createFakeWebAuthnClient(opts: FakeWebAuthnOptions = {}): FakeWebAuthn {
  const deviceSecret = opts.seed !== undefined ? h(stringToBytes(`${FAKE_WEBAUTHN_MARKER}/${opts.seed}`)) : crypto.getRandomValues(new Uint8Array(32));
  const prf = (credentialId: Uint8Array, salt: Uint8Array) => h(deviceSecret, credentialId, salt);
  let counter = 0;
  const fake: FakeWebAuthn = {
    calls: { create: 0, get: 0 },
    failNext: [...(opts.failNext ?? [])],
    credentials: [],
    async createCredential(req) {
      fake.calls.create++;
      const f = fake.failNext.shift();
      if (f) throw f;
      const id = h(stringToBytes(`${opts.seed ?? "random"}/credential/${counter++}/${req.user.name}`));
      fake.credentials.push(id);
      return opts.noPrf ? { credentialId: id, transports: ["internal", "hybrid"], prfEnabled: false } : { credentialId: id, transports: ["internal", "hybrid"], prfEnabled: true, prfOutput: prf(id, req.prfSalt) };
    },
    async getCredential(req) {
      fake.calls.get++;
      const f = fake.failNext.shift();
      if (f) throw f;
      const id = req.allowCredential?.credentialId ?? fake.credentials[fake.credentials.length - 1];
      if (!id || !fake.credentials.some((c) => c.length === id.length && c.every((b, i) => b === id[i]))) throw { error: "NoCredentials", message: "No viable credential is available for the user." };
      return opts.noPrf ? { credentialId: id } : { credentialId: id, prfOutput: prf(id, req.prfSalt) };
    },
  };
  return fake;
}

/** The fake the dev app uses (one per process). */
export const devFakeWebAuthnClient: WebAuthnClient = createFakeWebAuthnClient();
