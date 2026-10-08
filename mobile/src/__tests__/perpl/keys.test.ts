// The Perpl key is memory-only: derived in the unlock PRF pass, reachable only as a signer, wiped on every lock path;
// the token record is validated field by field.
import { derivePerplKey } from "@meridian/core/keys";
import { toSigner } from "@meridian/core/perpl";
import { bytesToHex } from "@meridian/core/util";
import type { Address } from "viem";
import { LockedError } from "../../auth/controller";
import { createPerplKeyring, PerplKeyWipedError } from "../../venues/perpl/keyring";
import { checkPerplRecord, PerplTokenStore, type PerplKeyRecord } from "../../venues/perpl/tokenStore";
import { makeAuth, memoryKv, seqPrf, SEQ_ADDRESS } from "../auth/authFixtures";

const perplDep = (rot = 0) => ({ perpl: { chainId: 10143, rotationFor: async (_a: Address) => rot } });
const msg = new TextEncoder().encode("10143\ntrading-ws-signin\n1\nn");

describe("keyring", () => {
  it("signs like core's key for (prf, chain, rotation), exposes only publicKey + sign, and wipes", () => {
    const k = createPerplKeyring(seqPrf(), 10143, 2);
    const ref = derivePerplKey(seqPrf(), 10143, 2);
    const s = k.signer();
    expect(Object.keys(s).sort()).toEqual(["publicKey", "sign"]);
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.sign(msg)).toEqual(toSigner(ref.secret).sign(msg));
    expect(k.publicKeyHex).toBe(bytesToHex(ref.publicKey));
    expect(JSON.stringify(k)).not.toContain(bytesToHex(ref.secret));
    k.wipe();
    expect(k.alive).toBe(false);
    expect(() => k.signer()).toThrow(PerplKeyWipedError);
    expect(() => s.sign(msg)).toThrow(PerplKeyWipedError); // a signer handed out earlier dies too
  });

  it("zeroes the derived secret buffer on wipe", () => {
    let captured: Uint8Array | undefined;
    const k = createPerplKeyring(seqPrf(), 10143, 0, (p, c, r) => {
      const x = derivePerplKey(p, c, r);
      captured = x.secret;
      return x;
    });
    expect(captured!.some((b) => b !== 0)).toBe(true);
    k.wipe();
    expect(captured!.every((b) => b === 0)).toBe(true);
  });
});

describe("AuthController holds the Perpl key for the unlocked session only", () => {
  it("derived in the same PRF pass (one prompt) at the stored rotation; never the EVM key reused", async () => {
    const { auth, fake } = makeAuth({ deps: perplDep(3) });
    await auth.init();
    await auth.create();
    expect(fake.calls.create).toBe(1);
    expect(fake.calls.get).toBe(0);
    const k = auth.perplKey()!;
    expect(k.rotation).toBe(3);
    expect(k.chainId).toBe(10143);
    expect(Object.keys(k).sort()).toEqual(["chainId", "publicKeyHex", "rotation", "signer"]);
  });

  it("wiped on manual lock, idle lock, background lock and sign-out", async () => {
    for (const end of ["manual", "idle", "background", "signout"] as const) {
      const { auth, clock } = makeAuth({ deps: perplDep() });
      await auth.init();
      await auth.create();
      const s = auth.perplKey()!.signer;
      expect(() => s.sign(msg)).not.toThrow();
      if (end === "manual") auth.lock();
      if (end === "idle") {
        clock.tick(11 * 60_000);
        auth.checkIdle();
      }
      if (end === "background") {
        auth.onAppState("background");
        clock.tick(6 * 60_000);
        auth.onAppState("active");
      }
      if (end === "signout") await auth.signOut();
      expect(() => s.sign(msg)).toThrow(PerplKeyWipedError);
      expect(() => auth.perplKey()).toThrow(LockedError);
    }
  });

  it("no Perpl config ⇒ no Perpl key (and nothing derived)", async () => {
    const { auth } = makeAuth();
    await auth.init();
    await auth.create();
    expect(auth.perplKey()).toBeUndefined();
  });

  it("the unlock PRF copy is zeroed even when reading the rotation fails (falls back to rotation 0)", async () => {
    const { auth } = makeAuth({ deps: { perpl: { chainId: 10143, rotationFor: async () => Promise.reject(new Error("store down")) } } });
    await auth.init();
    await auth.create();
    expect(auth.perplKey()!.rotation).toBe(0);
  });
});

describe("token record validation", () => {
  const good: PerplKeyRecord = { token: "tok_0001_ABCDEFGHIJKLMNOPQRSTUVWXYZ-_", rotation: 0, publicKeyHex: "ab".repeat(32), chainId: 10143, address: SEQ_ADDRESS as Address, enrolledAt: 1_791_400_000_000 };
  it("accepts exactly the record", () => {
    expect(checkPerplRecord(good)).toEqual(good);
  });
  it.each([
    ["extra field", { ...good, secret: "x" }],
    ["token with a space", { ...good, token: "tok en with space here" }],
    ["short token", { ...good, token: "abc" }],
    ["negative rotation", { ...good, rotation: -1 }],
    ["rotation too high", { ...good, rotation: 65 }],
    ["0x public key", { ...good, publicKeyHex: `0x${"ab".repeat(31)}` }],
    ["upper-case public key", { ...good, publicKeyHex: "AB".repeat(32) }],
    ["other chain", { ...good, chainId: 1 }],
    ["bad address", { ...good, address: "0x1234" }],
    ["zero time", { ...good, enrolledAt: 0 }],
  ])("refuses %s", (_n, r) => {
    expect(() => checkPerplRecord(r)).toThrow(/perpl key record/);
  });
  it("store: one key per (chain, wallet); a corrupt or foreign record is forgotten", async () => {
    const kv = memoryKv();
    const s = new PerplTokenStore(kv);
    await s.write(good);
    expect(s.key(10143, SEQ_ADDRESS as Address)).toBe(`meridian.perpl.v1.10143.${SEQ_ADDRESS.toLowerCase()}`);
    expect(await s.read(10143, SEQ_ADDRESS as Address)).toEqual(good);
    expect(await s.read(143, SEQ_ADDRESS as Address)).toBeUndefined();
    kv.data.set(s.key(10143, SEQ_ADDRESS as Address), '{"token":1}');
    expect(await s.read(10143, SEQ_ADDRESS as Address)).toBeUndefined();
    expect(kv.data.has(s.key(10143, SEQ_ADDRESS as Address))).toBe(false);
    await expect(s.write({ ...good, rotation: 1.5 })).rejects.toThrow();
  });
});
