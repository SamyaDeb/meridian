// TEST ONLY: a fake WebAuthn client (Mera's WebAuthnClient interface) for vitest. Never imported by app code.
// Each credential answers with a PRF the test chooses, so a fixed PRF can be checked against core's address vectors.
import type { WebAuthnClient } from "@category-labs/mera";

export type FakeAuthenticator = WebAuthnClient & {
  calls: { create: number; get: number };
  /** throw this from the next ceremony (e.g. a DOMException-like { name: "NotAllowedError" }) */
  failNext: unknown[];
  /** PRF per credential id byte 0 */
  prfs: Map<number, Uint8Array>;
  noPrf: boolean;
};

/** `prfsInOrder[i]` = PRF of the i-th credential created (or registered up front with `preload`). */
export function fakeAuthenticator(prfsInOrder: Uint8Array[], opts: { preload?: number; noPrf?: boolean } = {}): FakeAuthenticator {
  let next = 0;
  const held: number[] = [];
  const idOf = (n: number) => new Uint8Array(32).fill(n + 1);
  for (let i = 0; i < (opts.preload ?? 0); i++) held.push(next++);
  const fake: FakeAuthenticator = {
    calls: { create: 0, get: 0 },
    failNext: [],
    prfs: new Map(prfsInOrder.map((p, i) => [i + 1, p])),
    noPrf: opts.noPrf ?? false,
    async createCredential() {
      fake.calls.create++;
      if (fake.failNext.length) throw fake.failNext.shift();
      const n = next++;
      held.push(n);
      const id = idOf(n);
      return fake.noPrf ? { credentialId: id, prfEnabled: false } : { credentialId: id, transports: ["internal", "hybrid"], prfEnabled: true, prfOutput: fake.prfs.get(n + 1)!.slice() };
    },
    async getCredential(req) {
      fake.calls.get++;
      if (fake.failNext.length) throw fake.failNext.shift();
      const n = req.allowCredential ? req.allowCredential.credentialId[0]! - 1 : held[held.length - 1];
      if (n === undefined || !held.includes(n)) throw Object.assign(new Error("no credential"), { name: "NotAllowedError" });
      return fake.noPrf ? { credentialId: idOf(n) } : { credentialId: idOf(n), prfOutput: fake.prfs.get(n + 1)!.slice() };
    },
  };
  return fake;
}

/** In-memory localStorage stand-in. */
export function memoryKV(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; dump(): string } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => JSON.stringify([...m]),
  };
}

/** Fixed test PRFs (never a real passkey): 0x01…20 and all 0xab. SEQ's address is core's vector (packages/core/test/keys.test.ts). */
export const PRF_SEQ = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const PRF_AB = new Uint8Array(32).fill(0xab);
export const SEQ_ADDRESS = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";
