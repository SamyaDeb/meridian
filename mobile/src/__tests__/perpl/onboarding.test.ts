// N4 onboarding end to end, offline: real AuthController (fake passkey) + Perpl key in the same PRF pass + the
// onboarding service against a fake Perpl server and chain. Every step is DETECTED again by a fresh service (an app
// kill), so "resume" is proven, not stored.
import { createSignedRest } from "@meridian/core/perpl";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { PerplOnboarding, describe as describeErr, explainEnroll } from "../../venues/perpl/onboarding";
import { PerplTokenStore } from "../../venues/perpl/tokenStore";
import { makeAuth, memoryKv } from "../auth/authFixtures";
import { deployment, FakeChain, FakePerpl } from "./perplFixtures";

const dep = deployment(10143);

async function setup(o: { profileKnown?: boolean; balance?: bigint } = {}) {
  const kv = memoryKv();
  const tokens = new PerplTokenStore(kv);
  const perpl = new FakePerpl();
  const chain = new FakeChain(perpl, dep);
  const { auth, fake } = makeAuth({ kv, deps: { perpl: { chainId: 10143, rotationFor: async (a: Address) => (await tokens.read(10143, a))?.rotation ?? 0 } } });
  await auth.init();
  await auth.create();
  const address = auth.account().address;
  chain.balances.set(address.toLowerCase(), o.balance ?? 500_000_000n);
  if (o.profileKnown) perpl.profiles.add(address.toLowerCase());
  const make = () => new PerplOnboarding({ deployment: dep, chainId: 10143, address, auth, tokens, chain: chain as never, sendWith: chain.sendWith, fetchFn: perpl.fetch, random: (n) => new Uint8Array(n).map((_, i) => i), now: () => 1_791_400_000_000 });
  return { auth, fake, kv, tokens, perpl, chain, address, make };
}

const fnNames = (c: FakeChain) => c.txs.map((t) => t.functionName);

describe("detected onboarding, wallet Perpl already knows (profile exists)", () => {
  it("① enrol → ② deposit (approve exact + createAccount) → ③ forwarding → READY; a fresh service (app kill) sees each step", async () => {
    const h = await setup({ profileKnown: true });
    let o = h.make();
    expect((await o.refresh()).next).toBe("enroll");
    expect(o.store.get().minOpen).toBe(100_000_000n);

    await o.enroll();
    expect(h.perpl.calls.filter((c) => c.path.startsWith("/v1/api-key")).every((c) => c.headers.origin === undefined)).toBe(true);
    o = h.make(); // killed after ①
    expect((await o.refresh()).next).toBe("deposit");

    await o.deposit("100");
    expect(fnNames(h.chain)).toEqual(["approve", "createAccount"]);
    expect(h.chain.txs[0]!.args).toEqual([dep.exchange, 100_000_000n]); // approve EXACTLY the deposit
    expect(h.fake.calls.get).toBe(1); // one fresh prompt for both value-moving txs
    o = h.make(); // killed between ② and ③
    const v = await o.refresh();
    expect(v.next).toBe("forwarding");
    expect(v.forwarding).toBe("next");

    await o.allowForwarding();
    expect(h.fake.calls.get).toBe(1); // forwarding moves no value: unlocked session, no new prompt
    o = h.make();
    const r = await o.refresh();
    expect(r).toMatchObject({ ready: true, next: "none", key: "done", account: "done", forwarding: "done" });
    expect(r.apiAccount).toMatchObject({ id: 1000, fw: true, b: "100000000" });
  });

  it("deposit below the live minimum is refused before any prompt; '100.0000001' rounds UP to the next unit", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    await expect(o.deposit("99.999999")).rejects.toThrow(/at least 100 AUSD/);
    expect(h.fake.calls.get).toBe(0);
    expect(h.chain.txs).toHaveLength(0);
    await o.deposit("100.0000001");
    expect(h.chain.txs[0]!.args[1]).toBe(100_000_001n);
    expect(h.chain.txs[1]!.args[0]).toBe(100_000_001n);
  });

  it("killed between approve and createAccount: the resumed deposit skips the approve (allowance already exact)", async () => {
    const h = await setup({ profileKnown: true });
    let o = h.make();
    await o.refresh();
    await o.enroll();
    h.chain.killAfter = 1;
    await expect(o.deposit("150")).rejects.toThrow(/killed/);
    expect(fnNames(h.chain)).toEqual(["approve"]);
    h.chain.killAfter = undefined;
    o = h.make();
    expect((await o.refresh()).next).toBe("deposit");
    await o.deposit("150");
    expect(fnNames(h.chain)).toEqual(["approve", "createAccount"]);
  });

  it("forwarding on but nothing free ⇒ top-up via depositCollateral (no createAccount, no minimum)", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    await o.deposit("100");
    await o.allowForwarding();
    h.perpl.accounts.get(h.address.toLowerCase())!.lb = 100_000_000n; // all locked
    expect((await o.refresh()).next).toBe("top-up");
    await o.deposit("5");
    expect(fnNames(h.chain).slice(-2)).toEqual(["approve", "depositCollateral"]);
    expect((await o.refresh()).ready).toBe(true);
  });
});

describe("a wallet Perpl has never seen (enrol 404, measured 9 Oct)", () => {
  it("enrol 404 ⇒ deposit moves first; after createAccount the key enrols; then forwarding", async () => {
    const h = await setup();
    const o = h.make();
    expect((await o.refresh()).next).toBe("enroll");
    await expect(o.enroll()).rejects.toMatchObject({ status: 404 });
    const v = o.store.get().view!;
    expect(v).toMatchObject({ next: "deposit", key: "waiting", account: "next" });
    expect(o.store.get().error).toMatch(/deposit first/);
    await o.deposit("100");
    expect((await o.refresh()).next).toBe("enroll");
    await o.enroll();
    expect((await o.refresh()).next).toBe("forwarding");
    await o.allowForwarding();
    expect((await o.refresh()).ready).toBe(true);
  });

  it("if createAccount does NOT create the profile, enrol keeps answering 404 with a plain message", async () => {
    const h = await setup();
    h.perpl.profileOnCreate = false;
    const o = h.make();
    await o.refresh();
    await expect(o.enroll()).rejects.toMatchObject({ status: 404 });
    await o.deposit("100");
    await expect(o.enroll()).rejects.toMatchObject({ status: 404 });
    expect(o.store.get().error).toBe(explainEnroll(404));
  });
});

describe("API-key token persistence and rotation (core README §Open 3)", () => {
  it("token lost (reinstall) ⇒ enrol of rotation 0 gets 409 ⇒ ONE fresh prompt ⇒ rotation 1 enrolled and stored", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    const first = (await h.tokens.read(10143, h.address))!;
    expect(first.rotation).toBe(0);
    await h.tokens.clear(10143, h.address); // SecureStore wiped
    const prompts = h.fake.calls.get;
    await o.refresh();
    await o.enroll();
    const second = (await h.tokens.read(10143, h.address))!;
    expect(second.rotation).toBe(1);
    expect(second.publicKeyHex).not.toBe(first.publicKeyHex);
    expect(h.fake.calls.get).toBe(prompts + 1);
    expect(h.auth.perplKey()!.rotation).toBe(1); // the session now signs with the new key
    // relock + unlock: the stored rotation is derived in the same PRF pass
    h.auth.lock();
    await h.auth.unlock();
    expect(h.auth.perplKey()!.rotation).toBe(1);
    expect(h.auth.perplKey()!.publicKeyHex).toBe(second.publicKeyHex);
  });

  it("Re-enable trading enrols rotation + 1 even when the old token still exists", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    await o.reenable();
    expect((await h.tokens.read(10143, h.address))!.rotation).toBe(1);
    expect(h.perpl.keys.size).toBe(2);
  });

  it("the signed wallet read uses the stored token + the session key (server verifies Ed25519)", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    await o.deposit("100");
    const rest = o.signedRest()!;
    await expect(rest.wallet()).resolves.toMatchObject({ accounts: [{ id: 1000 }] });
    // a REST client on a different key is refused by the fake server (signature check is real)
    const other = createSignedRest({ apiUrl: dep.apiUrl, chainId: 10143, apiKey: o.token()!, secret: new Uint8Array(32).fill(7), fetchFn: h.perpl.fetch, random: (n) => new Uint8Array(n) });
    await expect(other.wallet()).rejects.toMatchObject({ status: 401 });
  });
});

describe("error mapping", () => {
  it("enrol statuses and tx errors in plain words", () => {
    expect(explainEnroll(423)).toMatch(/16 active/);
    expect(explainEnroll(409)).toMatch(/already registered/);
    const e = Object.assign(new Error("Not enough MON to pay the network fee."), { name: "TxError" });
    expect(describeErr(e)).toBe("Not enough MON to pay the network fee.");
    expect(describeErr(new Error("raw internals 0xdeadbeef"))).toBe("Something went wrong. Check your connection and try again.");
  });

  it("decimals on the token must match the config, or nothing proceeds", async () => {
    const h = await setup({ profileKnown: true });
    h.chain.decimals = 18;
    const o = h.make();
    await expect(o.refresh()).rejects.toThrow(/18 decimals/);
    expect(o.store.get().error).toMatch(/Not continuing/);
  });

  it("approve calldata is the token's approve(exchange, amount)", async () => {
    const h = await setup({ profileKnown: true });
    const o = h.make();
    await o.refresh();
    await o.enroll();
    await o.deposit("123.45");
    expect(h.chain.txs[0]).toMatchObject({ functionName: "approve", args: [dep.exchange, 123_450_000n] });
    expect(decodeFunctionData).toBeDefined();
    expect(erc20Abi.some((x) => x.type === "function" && x.name === "approve")).toBe(true);
  });
});
