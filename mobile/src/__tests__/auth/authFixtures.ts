// Shared fixtures for the N3 auth tests: in-memory KV that records every write, a manual clock, a controller factory.
import { AuthController, type AuthClock, type AuthDeps } from "../../auth/controller";
import type { KV } from "../../auth/credentialStore";
import { createFakeWebAuthnClient, type FakeWebAuthnOptions } from "../../auth/fakeWebAuthn";

export const DEV_CFG = { env: "development" as const, rpId: "meridian-testnet.vercel.app", androidPackage: "xyz.meridianfi.app.staging" };

/** Fixed synthetic PRF (bytes 0x01..0x20), the same input as core's keys.test.ts "SEQ" vector. Built at runtime. */
export const seqPrf = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
/** core keys.test.ts fixed vector: address of index 0 for seqPrf() (public). */
export const SEQ_ADDRESS = "0x50B240678777451BEfd67B7e8c3b4366482ba8F9";

export function memoryKv(): KV & { data: Map<string, string>; writes: { key: string; value: string }[] } {
  const data = new Map<string, string>();
  const writes: { key: string; value: string }[] = [];
  return {
    data,
    writes,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      writes.push({ key: k, value: v });
      data.set(k, v);
    },
    del: async (k) => void data.delete(k),
  };
}

export function manualClock(start = 1_700_000_000_000): AuthClock & { tick(ms: number): void; fire(): void; active: number } {
  let now = start;
  const timers = new Map<number, () => void>();
  let id = 0;
  const c = {
    now: () => now,
    every: (_ms: number, fn: () => void) => {
      timers.set(++id, fn);
      return id;
    },
    cancel: (h: unknown) => void timers.delete(h as number),
    nextFrame: async () => undefined,
    tick: (ms: number) => void (now += ms),
    /** run every registered interval callback once */
    fire: () => [...timers.values()].forEach((f) => f()),
    get active() {
      return timers.size;
    },
  };
  return c;
}

export function makeAuth(o: { kv?: ReturnType<typeof memoryKv>; clock?: ReturnType<typeof manualClock>; fake?: FakeWebAuthnOptions; deps?: Partial<AuthDeps> } = {}) {
  const kv = o.kv ?? memoryKv();
  const clock = o.clock ?? manualClock();
  const fake = createFakeWebAuthnClient({ seed: "device-1", ...o.fake });
  const auth = new AuthController({ cfg: DEV_CFG, kv, webAuthnClient: fake, clock, ...o.deps });
  return { auth, kv, clock, fake };
}
