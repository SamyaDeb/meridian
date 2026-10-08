// PerplSigner (auth.ts): every signing entry point accepts an in-memory signer instead of the raw Ed25519 secret, with
// byte-identical output. The app (MOBILE_PLAN N4) keeps the key behind such a signer and never hands core the bytes.
import { hashTypedData, type TypedDataDefinition } from "viem";
import { describe, expect, it } from "vitest";
import { parseSecret, publicKeyHex, restHeaders, signCanonical, signInFrame, toSigner, type PerplSigner } from "../src/perpl/auth";
import { edVerify } from "../src/perpl/ed";
import { payloadRequest, popSignature } from "../src/perpl/enroll";
import { createSignedRest } from "../src/perpl/rest";
import { PerplTrading } from "../src/perpl/trading";
import { hexToBytes } from "../src/util/bytes";
import { FakeClock, FakeWs, fakeFetch, sentAtLeast } from "./helpers";

const secret = parseSecret("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // RFC 8032 test key
const NONCE = "AAECAwQFBgcICQoLDA0ODw";
const TS = 1_791_380_000_000;

/** A signer that only exposes sign + publicKey, the way the app's keyring does (secret captured in a closure). */
function closureSigner(): PerplSigner & { calls: number } {
  const inner = toSigner(Uint8Array.from(secret));
  const s = { calls: 0, publicKey: inner.publicKey, sign: (m: Uint8Array) => (s.calls++, inner.sign(m)) };
  return s;
}

const def = {
  domain: { name: "Perpl", version: "1", chainId: 10143n, verifyingContract: "0x1964c32f0be608e7d29302aff5e61268e72080cc" },
  types: { Enroll: [{ name: "publicKey", type: "bytes32" }] },
  primaryType: "Enroll",
  message: { publicKey: "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" },
} as unknown as TypedDataDefinition;

describe("PerplSigner: same signatures as the raw secret", () => {
  it("canonical strings, public key, REST headers and the WS sign-in frame", async () => {
    const s = closureSigner();
    expect(await signCanonical("", s)).toBe(await signCanonical("", secret));
    expect(await publicKeyHex(s)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const i = { chainId: 10143, method: "GET", target: "/v1/trading/wallet", timestampMs: TS, nonce: NONCE, body: "" };
    expect(await restHeaders("tok", s, i)).toEqual(await restHeaders("tok", secret, i));
    expect(await signInFrame("tok", s, { chainId: 10143, timestampMs: TS, nonce: NONCE })).toEqual(await signInFrame("tok", secret, { chainId: 10143, timestampMs: TS, nonce: NONCE }));
    expect(s.calls).toBe(3);
  });

  it("enrolment: payload public key and the PoP over the EIP-712 digest", () => {
    const s = closureSigner();
    expect(payloadRequest({ chainId: 10143, address: "0x0000000000000000000000000000000000000001", secret: s, label: "L" }).public_key).toBe("0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const pop = popSignature(def, s);
    expect(pop).toBe(popSignature(def, secret));
    expect(edVerify(hexToBytes(pop), hexToBytes(hashTypedData(def)), s.publicKey)).toBe(true);
  });

  it("signed REST and the trading socket run on a signer", async () => {
    const s = closureSigner();
    const clock = new FakeClock();
    const f = fakeFetch(() => ({ status: 200, body: { as: [] } }));
    await createSignedRest({ apiUrl: "https://testnet.perpl.xyz/api", chainId: 10143, apiKey: "tok", secret: s, fetchFn: f, random: () => hexToBytes("000102030405060708090a0b0c0d0e0f"), clock }).wallet();
    expect(f.calls[0]!.init.headers["X-API-Signature"]).toBe((await restHeaders("tok", secret, { chainId: 10143, method: "GET", target: "/v1/trading/wallet", timestampMs: clock.now(), nonce: NONCE, body: "" }))["X-API-Signature"]);

    const sockets: FakeWs[] = [];
    const t = new PerplTrading({ apiUrl: "https://x/api", wsUrl: "wss://x", chainId: 10143, apiKey: "tok", secret: s, marketId: 64, orderTtlBlocks: 20, clock, fetchFn: f, random: () => hexToBytes("000102030405060708090a0b0c0d0e0f"), factory: (u) => (sockets.push(new FakeWs(u)), sockets.at(-1)!) });
    t.start();
    sockets[0]!.open();
    await sentAtLeast(sockets[0]!);
    expect(sockets[0]!.sent[0]).toEqual(await signInFrame("tok", secret, { chainId: 10143, timestampMs: clock.now(), nonce: NONCE }));
    t.stop();
  });

  it("toSigner(secret) exposes no secret-shaped property", () => {
    const s = toSigner(Uint8Array.from(secret));
    const own = Object.getOwnPropertyNames(s);
    expect(own.sort()).toEqual(["publicKey", "sign"]);
    expect(JSON.stringify(s)).not.toContain("157"); // first secret byte 0x9d = 157 never serialised
    expect(toSigner(s)).toBe(s);
  });
});
