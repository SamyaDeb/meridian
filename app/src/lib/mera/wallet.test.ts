import { describe, expect, it } from "vitest";
import { recoveryPhrase } from "@meridian/core/keys";
import { mnemonicToAccount } from "viem/accounts";
import { readRecord, RECORD_KEY } from "./record";
import { HIDDEN_LOCK_MS, IDLE_LOCK_MS, PasskeyWallet } from "./wallet";
import { PASSKEY_MESSAGES } from "./errors";
import { fakeAuthenticator, memoryKV, PRF_AB, PRF_SEQ, SEQ_ADDRESS } from "./testing";

const RP = "meridian-testnet.vercel.app";

function setup(prfs = [PRF_SEQ, PRF_AB], opts: { preload?: number; noPrf?: boolean } = {}) {
  const auth = fakeAuthenticator(prfs, opts);
  const kv = memoryKV();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const wallet = new PasskeyWallet({ rpId: RP, kv, webAuthnClient: auth, now: clock.now });
  return { auth, kv, clock, wallet };
}

describe("PasskeyWallet: create / unlock", () => {
  it("create → unlocked at core's address for that PRF (same derivation as the native app)", async () => {
    const { wallet, kv } = setup();
    expect(wallet.getState()).toEqual({ status: "locked", addressHint: undefined, reason: "start" });
    const a = await wallet.create("Meridian test");
    expect(a).toBe(SEQ_ADDRESS);
    expect(wallet.getState()).toEqual({ status: "unlocked", address: SEQ_ADDRESS });
    expect(wallet.account()?.address).toBe(SEQ_ADDRESS);
    expect(readRecord(kv)?.addressHint).toBe(SEQ_ADDRESS);
  });

  it("the account signs: the signature recovers to the wallet address", async () => {
    const { wallet } = setup();
    await wallet.create("x");
    const sig = await wallet.account()!.signMessage({ message: "meridian" });
    const { verifyMessage } = await import("viem");
    expect(await verifyMessage({ address: SEQ_ADDRESS, message: "meridian", signature: sig })).toBe(true);
  });

  it("storage holds only the credential record: no PRF, key, or phrase (storage scan)", async () => {
    const { wallet, kv } = setup();
    await wallet.create("x");
    const dump = kv.dump();
    expect(Object.keys(JSON.parse(JSON.parse(dump)[0][1])).sort()).toEqual(["addressHint", "createdAt", "credentialId", "transports"]);
    expect(JSON.parse(dump)[0][0]).toBe(RECORD_KEY);
    const phrase = recoveryPhrase(PRF_SEQ);
    for (const secret of [phrase, phrase.split(" ")[0]!, Buffer.from(PRF_SEQ).toString("hex"), Buffer.from(PRF_SEQ).toString("base64")]) expect(dump).not.toContain(secret);
  });

  it("reload: the hint comes back, unlock asks for the remembered passkey and opens the same address", async () => {
    const { wallet, kv, auth } = setup();
    await wallet.create("x");
    const again = new PasskeyWallet({ rpId: RP, kv, webAuthnClient: auth });
    expect(again.getState()).toMatchObject({ status: "locked", addressHint: SEQ_ADDRESS, reason: "start" });
    expect(await again.unlock()).toBe(SEQ_ADDRESS);
  });

  it("sign in with any passkey (e.g. the phone's) when nothing is remembered", async () => {
    const { wallet } = setup([PRF_SEQ], { preload: 1 });
    expect(await wallet.unlock(true)).toBe(SEQ_ADDRESS);
  });

  it("a cancelled prompt leaves it locked with a plain line, and a retry works", async () => {
    const { wallet, auth } = setup();
    auth.failNext.push(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }));
    expect(await wallet.create("x")).toBeUndefined();
    expect(wallet.getState()).toMatchObject({ status: "locked", reason: "failed", error: PASSKEY_MESSAGES.cancelled });
    expect(await wallet.create("x")).toBeDefined();
  });

  it("an authenticator without PRF is refused with the browser hint", async () => {
    const { wallet } = setup([PRF_SEQ], { noPrf: true });
    expect(await wallet.create("x")).toBeUndefined();
    expect(wallet.getState()).toMatchObject({ status: "locked", error: PASSKEY_MESSAGES.prfUnavailable });
  });

  it("one ceremony at a time: a second call while unlocking does nothing", async () => {
    const { wallet, auth } = setup();
    const [a, b] = await Promise.all([wallet.create("x"), wallet.create("y")]);
    expect(a).toBe(SEQ_ADDRESS);
    expect(b).toBeUndefined();
    expect(auth.calls.create).toBe(1);
  });
});

describe("PasskeyWallet: locks", () => {
  it("locks after 10 min idle; input pushes it back", async () => {
    const { wallet, clock } = setup();
    await wallet.create("x");
    clock.advance(IDLE_LOCK_MS - 1);
    wallet.touch();
    clock.advance(IDLE_LOCK_MS - 1);
    wallet.tick();
    expect(wallet.getState().status).toBe("unlocked");
    clock.advance(1);
    wallet.tick();
    expect(wallet.getState()).toEqual({ status: "locked", addressHint: SEQ_ADDRESS, reason: "idle" });
    expect(wallet.account()).toBeUndefined();
  });

  it("locks after 5 min hidden, not before", async () => {
    const { wallet, clock } = setup();
    await wallet.create("x");
    wallet.setHidden(true);
    clock.advance(HIDDEN_LOCK_MS);
    wallet.touch();
    wallet.tick();
    expect(wallet.getState().status).toBe("unlocked");
    clock.advance(1);
    wallet.setHidden(false);
    expect(wallet.getState()).toMatchObject({ status: "locked", reason: "hidden" });
  });

  it("a locked session can't sign (Mera SESSION_ENDED)", async () => {
    const { wallet } = setup();
    await wallet.create("x");
    const account = wallet.account()!;
    wallet.lock();
    await expect(account.signMessage({ message: "m" })).rejects.toMatchObject({ code: "SESSION_ENDED" });
  });

  it("forget clears the record and the hint", async () => {
    const { wallet, kv } = setup();
    await wallet.create("x");
    wallet.forget();
    expect(wallet.getState()).toEqual({ status: "locked", addressHint: undefined, reason: "forgot" });
    expect(readRecord(kv)).toBeUndefined();
  });
});

describe("PasskeyWallet: recovery phrase", () => {
  it("fresh prompt, phrase imports as the same address", async () => {
    const { wallet, auth } = setup();
    await wallet.create("x");
    const gets = auth.calls.get;
    const phrase = await wallet.revealPhrase();
    expect(auth.calls.get).toBe(gets + 1);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(mnemonicToAccount(phrase).address).toBe(SEQ_ADDRESS);
  });

  it("refused while locked", async () => {
    const { wallet } = setup();
    await expect(wallet.revealPhrase()).rejects.toThrow(/Unlock/);
  });

  it("refused when the passkey answering isn't this wallet's", async () => {
    const { wallet, auth } = setup();
    await wallet.create("x");
    auth.prfs.set(1, PRF_AB); // the same credential now answers with another PRF: a different wallet
    await expect(wallet.revealPhrase()).rejects.toThrow(/different wallet/);
  });
});
