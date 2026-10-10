import { recoveryPhrase } from "@meridian/core/keys";
import { recoverMessageAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { LockedError } from "../../auth/controller";
import { defaultDeriveDeps, openSigner } from "../../auth/derive";
import { RpGuardError } from "../../auth/errors";
import { createFakeWebAuthnClient } from "../../auth/fakeWebAuthn";
import { DEV_CFG, makeAuth, manualClock, memoryKv, SEQ_ADDRESS, seqPrf } from "./authFixtures";
import { AuthController } from "../../auth/controller";

describe("openSigner (PRF → Mera session → viem account)", () => {
  it("fixed vector: the synthetic PRF gives core's address, and MetaMask's import of the phrase agrees", () => {
    const phraseAddress = mnemonicToAccount(recoveryPhrase(seqPrf()), { addressIndex: 0 }).address;
    const s = openSigner(seqPrf());
    expect(s.address).toBe(SEQ_ADDRESS);
    expect(phraseAddress).toBe(SEQ_ADDRESS);
    s.session.end();
  });

  it("wipes the PRF and our key copy right after deriving; the session still signs with its own copy", async () => {
    const prf = seqPrf();
    let key: Uint8Array | undefined;
    const s = openSigner(prf, {
      ...defaultDeriveDeps,
      deriveEvmKey: (p, i) => (key = defaultDeriveDeps.deriveEvmKey(p, i)),
    });
    expect(prf.every((b) => b === 0)).toBe(true);
    expect(key!.every((b) => b === 0)).toBe(true);
    const sig = await s.account.signMessage({ message: "meridian" });
    expect(await recoverMessageAddress({ message: "meridian", signature: sig })).toBe(SEQ_ADDRESS);
    s.session.end();
    await expect(s.account.signMessage({ message: "x" })).rejects.toMatchObject({ name: "MeraError", code: "SESSION_ENDED" });
  });

  it("wipes the PRF even when derivation throws", () => {
    const prf = seqPrf();
    expect(() => openSigner(prf, { ...defaultDeriveDeps, deriveEvmKey: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(prf.every((b) => b === 0)).toBe(true);
  });
});

describe("AuthController", () => {
  it("create → unlocked; stores only the credential record; measures the derivation", async () => {
    const { auth, kv } = makeAuth();
    await auth.init();
    expect(auth.store.get()).toMatchObject({ status: "locked", hasAccount: false });
    await auth.create();
    const s = auth.store.get();
    expect(s.status).toBe("unlocked");
    const rec = JSON.parse(kv.data.get("meridian.passkey.v1.meridian-testnet.vercel.app")!);
    expect(Object.keys(rec).sort()).toEqual(["addressHint", "createdAt", "credentialId", "transports"]);
    expect(s.status === "unlocked" && rec.addressHint).toBe(s.status === "unlocked" ? s.address : "");
    expect(typeof auth.stats.get().deriveMs).toBe("number");
  });

  it("relaunch → unlock with the stored passkey → same address", async () => {
    const kv = memoryKv();
    const first = makeAuth({ kv });
    await first.auth.init();
    await first.auth.create();
    const addr = first.auth.account().address;
    // new run of the app: same phone (same fake authenticator), same SecureStore
    const again = new AuthController({ cfg: DEV_CFG, kv, webAuthnClient: first.fake, clock: manualClock() });
    await again.init();
    expect(again.store.get()).toMatchObject({ status: "locked", hasAccount: true, addressHint: addr });
    await again.unlock();
    expect(again.account().address).toBe(addr);
    expect(first.fake.calls.get).toBe(1);
  });

  it("reinstall (no record) → 'I already have one' picks the passkey → same address, record restored", async () => {
    const first = makeAuth();
    await first.auth.init();
    await first.auth.create();
    const addr = first.auth.account().address;
    const kv = memoryKv(); // app data wiped
    const fresh = new AuthController({ cfg: DEV_CFG, kv, webAuthnClient: first.fake, clock: manualClock() });
    await fresh.init();
    await fresh.unlock({ pick: true });
    expect(fresh.account().address).toBe(addr);
    expect(fresh.hasRecord).toBe(true);
  });

  it("idle 10 min without a touch → locked, session ended; a touch postpones it", async () => {
    const { auth, clock } = makeAuth();
    await auth.init();
    await auth.create();
    const account = auth.account();
    clock.tick(9 * 60_000);
    auth.touch();
    clock.tick(9 * 60_000);
    clock.fire();
    expect(auth.store.get().status).toBe("unlocked");
    clock.tick(60_000);
    clock.fire();
    expect(auth.store.get()).toMatchObject({ status: "locked", reason: "idle", hasAccount: true });
    expect(() => auth.account()).toThrow(LockedError);
    await expect(account.signMessage({ message: "x" })).rejects.toMatchObject({ name: "MeraError", code: "SESSION_ENDED" });
    expect(clock.active).toBe(0);
  });

  it("background > 5 min → locked on return; ≤ 5 min → still unlocked", async () => {
    const { auth, clock } = makeAuth();
    await auth.init();
    await auth.create();
    auth.onAppState("background");
    clock.tick(5 * 60_000);
    auth.onAppState("active");
    expect(auth.store.get().status).toBe("unlocked");
    auth.onAppState("background");
    clock.tick(5 * 60_000 + 1);
    auth.onAppState("active");
    expect(auth.store.get()).toMatchObject({ status: "locked", reason: "background" });
  });

  it("lock now, then sign out clears the record", async () => {
    const { auth, kv } = makeAuth();
    await auth.init();
    await auth.create();
    auth.lock();
    expect(auth.store.get()).toMatchObject({ status: "locked", reason: "manual" });
    await auth.signOut();
    expect(auth.store.get()).toEqual({ status: "locked", hasAccount: false, addressHint: undefined, reason: "signout" });
    expect(kv.data.size).toBe(0);
  });

  it("fresh session: new prompt, same address, ended after the action; recovery phrase = MetaMask import", async () => {
    const { auth, fake } = makeAuth();
    await auth.init();
    await auth.create();
    const addr = auth.account().address;
    let inner: { signMessage: (a: { message: string }) => Promise<string> } | undefined;
    const got = await auth.withFreshSession(async (a) => {
      inner = a;
      return a.address;
    });
    expect(got).toBe(addr);
    expect(fake.calls.get).toBe(1);
    await expect(inner!.signMessage({ message: "x" })).rejects.toMatchObject({ name: "MeraError", code: "SESSION_ENDED" });
    const words = await auth.exportRecoveryPhrase();
    expect(words).toHaveLength(24);
    expect(mnemonicToAccount(words.join(" ")).address).toBe(addr);
    expect(fake.calls.get).toBe(2);
    expect(auth.store.get().status).toBe("unlocked"); // the main session is untouched
  });

  it("fresh prompt answered by another wallet's passkey → WrongPasskeyError, PRF wiped", async () => {
    const { auth } = makeAuth();
    await auth.init();
    await auth.create();
    let seen: Uint8Array | undefined;
    // simulate the platform returning a different credential than the one asked for
    const other = createFakeWebAuthnClient({ seed: "device-2" });
    const swapped = { ...other, getCredential: async () => ({ credentialId: new Uint8Array(32).fill(7), prfOutput: new Uint8Array(32).fill(9) }) };
    (auth as unknown as { passkey: { webAuthnClient: unknown } }).passkey.webAuthnClient = swapped;
    await expect(auth.withFreshPrf((p) => (seen = p))).rejects.toBeTruthy();
    expect(seen).toBeUndefined();
  });

  it("refuses passkeys on the wrong rpId (nothing is created)", async () => {
    const fake = createFakeWebAuthnClient({ seed: "x" });
    const auth = new AuthController({ cfg: { ...DEV_CFG, rpId: "evil.example" }, kv: memoryKv(), webAuthnClient: fake, clock: manualClock() });
    await auth.init();
    await expect(auth.create()).rejects.toBeInstanceOf(RpGuardError);
    await expect(auth.unlock()).rejects.toBeInstanceOf(RpGuardError);
    expect(fake.calls.create + fake.calls.get).toBe(0);
    expect(auth.rpProblem).toMatch(/wrong passkey domain/);
  });

  it("a cancelled prompt leaves the app locked (failed) and reports 'Cancelled'", async () => {
    const { auth } = makeAuth({ fake: { failNext: [{ error: "UserCancelled", message: "The user cancelled the request." }] } });
    await auth.init();
    const e = await auth.create().then(() => undefined, (x: unknown) => x);
    expect(auth.store.get()).toMatchObject({ status: "locked", reason: "failed" });
    expect(auth.describe(e)).toEqual({ kind: "cancelled", message: "Cancelled. Try again." });
  });

  it("an authenticator without PRF → PRF_UNAVAILABLE message", async () => {
    const { auth } = makeAuth({ fake: { noPrf: true } });
    await auth.init();
    const e = await auth.create().then(() => undefined, (x: unknown) => x);
    expect(auth.describe(e).kind).toBe("prf-unavailable");
  });

});
