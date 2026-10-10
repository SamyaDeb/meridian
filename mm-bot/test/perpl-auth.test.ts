import { createHash, createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newNonce, parseSecret, publicKeyHex, redact, restCanonical, restHeaders, sha256Hex, signCanonical, signInFrame, wsSignInCanonical } from "../src/perpl/auth";

// RFC 8032 §7.1 TEST 1 key: a public test vector, never a real Perpl key.
const SECRET_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const secret = parseSecret(SECRET_HEX);
const NONCE = "AAECAwQFBgcICQoLDA0ODw"; // base64url of bytes 0..15
const TS = 1_791_380_000_000;

/** Independent Ed25519 (node:crypto / OpenSSL) to cross-check @noble/ed25519 on the canonical strings. */
const nodeSign = (msg: string) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SECRET_HEX, "hex")]), format: "der", type: "pkcs8" })).toString("base64url");

describe("Perpl API-key signing (authentication.md)", () => {
  it("RFC 8032 TEST 1: empty message, and the public key", async () => {
    const sig = await signCanonical("", secret);
    expect(Buffer.from(sig, "base64url").toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    expect(await publicKeyHex(secret)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  });

  it("REST canonical string: six fields joined by \\n, body hash of the empty string for GET", () => {
    expect(restCanonical({ chainId: 10143, method: "get", target: "/v1/trading/fills?count=1", timestampMs: TS, nonce: NONCE, body: "" })).toBe(
      "10143\nGET\n/v1/trading/fills?count=1\n1791380000000\nAAECAwQFBgcICQoLDA0ODw\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(() => restCanonical({ chainId: 10143, method: "GET", target: "v1/x", timestampMs: TS, nonce: NONCE, body: "" })).toThrow(/start with \//);
  });

  it("fixed vectors (key, timestamp, nonce → signature), equal to node:crypto's Ed25519", async () => {
    const get = restCanonical({ chainId: 10143, method: "GET", target: "/v1/trading/fills?count=1", timestampMs: TS, nonce: NONCE, body: "" });
    expect(await signCanonical(get, secret)).toBe("ZHDpqN2V19pvRVFgYshBr3oviDYhiS9prlbhgxq7v03NsTsNiPdDhbyAPmdqi6Pqn4tW9YOK8PjxNEtXiEjcCA");
    const body = JSON.stringify({ d: [{ rq: 1001, mkt: 64, acc: 7, t: 1, p: 2580, s: 100, fl: 4, lv: 500, lb: 123 }] });
    expect(sha256Hex(body)).toBe("7772a95dd1e4d9d81487b2432623e43d3153b619387914bc6f3ed9bd019f0740");
    const post = restCanonical({ chainId: 10143, method: "POST", target: "/v1/trading/orders", timestampMs: TS, nonce: NONCE, body });
    expect(await signCanonical(post, secret)).toBe("qyxrtDD17AfJQ02WSG0M5zg_6F99gKXLf67yhrPdwB12eQrcL6LHbFBLI5KWGAOhr_1QfSHdvKCotumr_Vj2Bw");
    const ws = wsSignInCanonical({ chainId: 10143, timestampMs: TS, nonce: NONCE });
    expect(ws).toBe("10143\ntrading-ws-signin\n1791380000000\nAAECAwQFBgcICQoLDA0ODw");
    expect(await signCanonical(ws, secret)).toBe("J458h0mCjhv_Qd6seev9zsH5Kuy2i019Ow7U06F14rvttlWPUQY_g0K2buseDonaeBJSWqVdJ76DTRz3JN-PAg");
    for (const m of [get, post, ws, "x".repeat(1000)]) expect(await signCanonical(m, secret)).toBe(nodeSign(m));
  });

  it("signatures are base64url without padding (86 chars for 64 bytes)", async () => {
    const s = await signCanonical("anything", secret);
    expect(s).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("headers and the mt: 29 sign-in frame carry exactly the documented fields", async () => {
    const h = await restHeaders("key-token", secret, { chainId: 10143, method: "GET", target: "/v1/trading/wallet", timestampMs: TS, nonce: NONCE, body: "" });
    expect(Object.keys(h).sort()).toEqual(["X-API-Key", "X-API-Nonce", "X-API-Signature", "X-API-Timestamp"]);
    expect(h["X-API-Timestamp"]).toBe("1791380000000");
    const f = await signInFrame("key-token", secret, { chainId: 10143, timestampMs: TS, nonce: NONCE });
    expect(f).toEqual({ mt: 29, chain_id: 10143, api_key: "key-token", timestamp: "1791380000000", nonce: NONCE, signature: "J458h0mCjhv_Qd6seev9zsH5Kuy2i019Ow7U06F14rvttlWPUQY_g0K2buseDonaeBJSWqVdJ76DTRz3JN-PAg" });
  });

  it("nonce: 16 random bytes base64url; secret parsing", () => {
    expect(newNonce((n) => Uint8Array.from({ length: n }, (_, i) => i))).toBe(NONCE);
    expect(parseSecret(`0x${SECRET_HEX}`)).toEqual(secret);
    expect(() => parseSecret("abc")).toThrow(/64 hex/);
    expect(() => parseSecret(SECRET_HEX + "00")).toThrow(/64 hex/);
  });

  it("redact: X-API-*, api_key, signature and secrets never reach a log", () => {
    const r = redact({ headers: { "X-API-Key": "k", "x-api-signature": "s", accept: "json" }, frame: { mt: 29, api_key: "k", signature: "s", nonce: "n" }, PERPL_API_KEY_SECRET: "z", list: [{ privateKey: "p" }] });
    expect(JSON.stringify(r)).not.toMatch(/"k"|"s"|"z"|"p"/);
    expect(r).toMatchObject({ headers: { accept: "json" }, frame: { mt: 29, nonce: "n" } });
  });
});

it("sha256Hex = node createHash", () => {
  expect(sha256Hex("héllo")).toBe(createHash("sha256").update("héllo").digest("hex"));
});
