// MOBILE_PLAN N3 §3: no key material in device storage. (1) Run every auth flow against a recording SecureStore mock and
// scan each written value for 32/64-byte hex and 12/24-word BIP-39 phrases. (2) Statically: only src/auth/secureKv.ts
// touches SecureStore, and nothing in src imports AsyncStorage / MMKV / the file system.
import { wordlist } from "@scure/bip39/wordlists/english";

const mockWrites: { key: string; value: string }[] = [];
const mockMem = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockMem.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    mockWrites.push({ key: k, value: v });
    mockMem.set(k, v);
  },
  deleteItemAsync: async (k: string) => void mockMem.delete(k),
}));

import { AuthController } from "../../auth/controller";
import { createFakeWebAuthnClient } from "../../auth/fakeWebAuthn";
import { secureKv } from "../../auth/secureKv";
import { fs, path, sourceFiles } from "../node";
import { DEV_CFG, manualClock } from "./authFixtures";

const WORDS = new Set(wordlist);
/** true if `s` contains a long hex run (≥ 32 bytes) or a run of ≥ 12 BIP-39 words */
export function looksSecret(s: string): boolean {
  if (/(0x)?[0-9a-fA-F]{64}/.test(s)) return true;
  const tokens = s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let run = 0;
  for (const t of tokens) {
    run = WORDS.has(t) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

it("the scanner catches what it must", () => {
  expect(looksSecret("ab".repeat(32))).toBe(true);
  expect(looksSecret(`0x${"cd".repeat(32)}`)).toBe(true);
  expect(looksSecret(`${"abandon ".repeat(11)}about`)).toBe(true);
  expect(looksSecret('{"addressHint":"0x50B240678777451BEfd67B7e8c3b4366482ba8F9"}')).toBe(false);
});

it("create, lock, unlock, fresh session, recovery export, sign-out: no secret is ever written", async () => {
  const fake = createFakeWebAuthnClient({ seed: "scan" });
  const auth = new AuthController({ cfg: DEV_CFG, kv: secureKv, webAuthnClient: fake, clock: manualClock() });
  await auth.init();
  await auth.create();
  auth.lock();
  await auth.unlock();
  await auth.withFreshSession(async (a) => a.address);
  const words = await auth.exportRecoveryPhrase();
  expect(words).toHaveLength(24);
  await auth.unlock({ pick: true }).catch(() => undefined);
  await auth.signOut();
  await auth.unlock({ pick: true });
  expect(mockWrites.length).toBeGreaterThan(0);
  for (const w of mockWrites) {
    expect(looksSecret(w.key)).toBe(false);
    expect(looksSecret(w.value)).toBe(false);
    const keys = Object.keys(JSON.parse(w.value));
    expect(keys).toEqual(expect.arrayContaining(["addressHint", "createdAt", "credentialId"]));
    expect(keys.every((k) => ["addressHint", "createdAt", "credentialId", "transports"].includes(k))).toBe(true);
  }
});

it("only src/auth/secureKv.ts imports SecureStore; no AsyncStorage / MMKV / file-system storage in the app", () => {
  for (const f of sourceFiles()) {
    const s = fs.readFileSync(f, "utf8");
    if (!f.endsWith(path.join("auth", "secureKv.ts"))) expect([f, /expo-secure-store/.test(s)]).toEqual([f, false]);
    expect([f, /@react-native-async-storage|react-native-mmkv|expo-file-system|expo-sqlite/.test(s)]).toEqual([f, false]);
  }
});
