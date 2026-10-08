// MOBILE_PLAN N4: the Perpl key is never at rest. Run the whole onboarding (create → enrol → 409 rotation → deposit →
// forwarding → lock/unlock) against a recording SecureStore and check every value written: only the two validated
// records exist, the Ed25519 secret (every rotation) and the PRF never appear, and nothing secret-shaped remains once
// the one known public value (the enrolled public key) is set aside.
import { derivePerplKey } from "@meridian/core/keys";
import { bytesToHex } from "@meridian/core/util";
import type { WebAuthnClient } from "@category-labs/mera";
import type { Address } from "viem";

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
import { PerplOnboarding } from "../../venues/perpl/onboarding";
import { PerplTokenStore } from "../../venues/perpl/tokenStore";
import { DEV_CFG, manualClock } from "../auth/authFixtures";
import { looksSecret } from "../secretScan";
import { deployment, FakeChain, FakePerpl } from "./perplFixtures";

it("full Perpl onboarding writes no key material", async () => {
  const dep = deployment(10143);
  const tokens = new PerplTokenStore(secureKv);
  const fake = createFakeWebAuthnClient({ seed: "perpl-scan" });
  // capture every PRF the controller sees, to prove none of them (nor keys derived from them) reach storage
  const prfs: Uint8Array[] = [];
  const keep = <T extends { prfOutput?: Uint8Array }>(r: T): T => (r.prfOutput && prfs.push(Uint8Array.from(r.prfOutput)), r);
  const client: WebAuthnClient = {
    createCredential: async (req) => keep(await fake.createCredential(req)),
    getCredential: async (req) => keep(await fake.getCredential(req)),
  };
  const auth = new AuthController({ cfg: DEV_CFG, kv: secureKv, webAuthnClient: client, clock: manualClock(), perpl: { chainId: 10143, rotationFor: async (x: Address) => (await tokens.read(10143, x))?.rotation ?? 0 } });
  await auth.init();
  await auth.create();
  const address = auth.account().address;
  const perpl = new FakePerpl();
  perpl.profiles.add(address.toLowerCase());
  const chain = new FakeChain(perpl, dep);
  chain.balances.set(address.toLowerCase(), 500_000_000n);
  const o = new PerplOnboarding({ deployment: dep, chainId: 10143, address, auth, tokens, chain: chain as never, sendWith: chain.sendWith, fetchFn: perpl.fetch, random: (n) => new Uint8Array(n), now: () => 1_791_400_000_000 });
  await o.refresh();
  await o.enroll();
  await tokens.clear(10143, address);
  await o.enroll(); // 409 ⇒ rotation 1 under a fresh prompt
  await o.deposit("100");
  await o.allowForwarding();
  auth.lock();
  await auth.unlock();
  await o.refresh();
  expect(auth.perplKey()!.rotation).toBe(1);

  const perplWrites = mockWrites.filter((w) => w.key.startsWith("meridian.perpl.v1."));
  expect(perplWrites.length).toBeGreaterThanOrEqual(2);
  // every PRF seen and every Perpl secret derivable from them (rotations 0–2), as hex
  expect(prfs.length).toBeGreaterThanOrEqual(3);
  const secrets = prfs.flatMap((p) => [bytesToHex(p), ...[0, 1, 2].map((r) => bytesToHex(derivePerplKey(p, 10143, r).secret))]);
  const pubs = new Set(perplWrites.map((w) => (JSON.parse(w.value) as { publicKeyHex: string }).publicKeyHex));
  for (const w of mockWrites) {
    expect(w.key.startsWith("meridian.perpl.v1.") || w.key.startsWith("meridian.passkey.v1.")).toBe(true);
    let v = w.value;
    for (const p of pubs) v = v.split(p).join("");
    expect(looksSecret(v)).toBe(false);
    for (const p of secrets) expect(w.value.toLowerCase()).not.toContain(p);
    if (w.key.startsWith("meridian.perpl.v1.")) expect(Object.keys(JSON.parse(w.value)).sort()).toEqual(["address", "chainId", "enrolledAt", "publicKeyHex", "rotation", "token"]);
  }
});

it("no Perpl module persists anything except through PerplTokenStore, and none logs", () => {
  const { fs, path, sourceFiles, SRC_DIR } = jest.requireActual("../node") as typeof import("../node");
  for (const f of sourceFiles(path.join(SRC_DIR, "venues"))) {
    const s = fs.readFileSync(f, "utf8");
    expect([f, /console\.|expo-secure-store|async-storage|\.setItem/.test(s)]).toEqual([f, false]);
  }
  // the secret derived for a given PRF never equals anything public we derive from it
  const k = derivePerplKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1), 10143, 0);
  expect(bytesToHex(k.secret)).not.toBe(bytesToHex(k.publicKey));
});
