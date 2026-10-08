import { hkdfSync } from "node:crypto";
import { bytesToHex as viemHex, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { PERPL_KEY_SALT, deriveEvmKey, derivePerplKey, recoveryPhrase } from "../src/keys";
import { bytesToHex } from "../src/util/bytes";

// Fixed PRF outputs (test-only, never a real passkey): all zeros = the official BIP-39 (Trezor) 256-bit entropy vector,
// and bytes 0x01..0x20.
const ZERO = new Uint8Array(32);
const SEQ = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe("deriveEvmKey (Mera docs: entropyToMnemonic(prf) → seed → m/44'/60'/0'/0/i)", () => {
  it("recovery phrase of all-zero entropy is the BIP-39 vector 'abandon ×23 art'", () => {
    expect(recoveryPhrase(ZERO)).toBe(`${"abandon ".repeat(23)}art`);
  });
  it("equals viem's mnemonicToAccount on the same phrase and index (what MetaMask/Rabby import gives)", () => {
    for (const prf of [ZERO, SEQ])
      for (const i of [0, 1, 7]) {
        const pk = deriveEvmKey(prf, i);
        expect(privateKeyToAddress(toHex(pk))).toBe(mnemonicToAccount(recoveryPhrase(prf), { addressIndex: i }).address);
      }
  });
  it("fixed vectors: a fixed PRF gives a fixed address", () => {
    expect(privateKeyToAddress(toHex(deriveEvmKey(SEQ, 0)))).toMatchInlineSnapshot(`"0x50B240678777451BEfd67B7e8c3b4366482ba8F9"`);
    expect(privateKeyToAddress(toHex(deriveEvmKey(ZERO, 0)))).toMatchInlineSnapshot(`"0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb"`);
  });
  it("rejects a PRF that isn't 32 bytes and hardened / negative indices", () => {
    expect(() => deriveEvmKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => deriveEvmKey(SEQ, -1)).toThrow(/index/);
    expect(() => deriveEvmKey(SEQ, 2 ** 31)).toThrow(/index/);
  });
});

describe("derivePerplKey = HKDF-SHA256(prf, salt 'meridian/perpl-api-key/v1', info String(chainId), 32) → Ed25519", () => {
  it("matches node:crypto hkdfSync byte for byte", () => {
    for (const chainId of [143, 10143]) {
      const want = new Uint8Array(hkdfSync("sha256", SEQ, Buffer.from(PERPL_KEY_SALT), Buffer.from(String(chainId)), 32));
      expect(derivePerplKey(SEQ, chainId).secret).toEqual(want);
    }
  });
  it("fixed vectors: secret and public key per chain", () => {
    const m = derivePerplKey(SEQ, 143);
    const t = derivePerplKey(SEQ, 10143);
    expect({ secret: bytesToHex(m.secret), publicKey: bytesToHex(m.publicKey) }).toMatchInlineSnapshot(`
      {
        "publicKey": "83c0b5a236439d167512d4220ef9211ce36a418080c328674c27d8ac13c1864d",
        "secret": "32b5e4616ef646aa61c5409535c5f95d7046ca998961ce9988bc577aca1c8d66",
      }
    `);
    expect({ secret: bytesToHex(t.secret), publicKey: bytesToHex(t.publicKey) }).toMatchInlineSnapshot(`
      {
        "publicKey": "84e005d5298f89bb2a331c60ca952223c38d64f0d49e70fbe29108d7c4c41c89",
        "secret": "398f5d583c309140b1449348e7adae9bff09a029cd765e0b451a6af995b0ee23",
      }
    `);
  });
  it("Perpl key bytes ≠ EVM key bytes; another chain or rotation ⇒ another key; deterministic", () => {
    const evm = viemHex(deriveEvmKey(SEQ, 0));
    expect(viemHex(derivePerplKey(SEQ, 143).secret)).not.toBe(evm);
    expect(viemHex(derivePerplKey(SEQ, 10143).secret)).not.toBe(evm);
    expect(derivePerplKey(SEQ, 143).secret).not.toEqual(derivePerplKey(SEQ, 10143).secret);
    expect(derivePerplKey(SEQ, 143, 1).secret).not.toEqual(derivePerplKey(SEQ, 143).secret);
    expect(derivePerplKey(SEQ, 143)).toEqual(derivePerplKey(Uint8Array.from(SEQ), 143));
    const rot = new Uint8Array(hkdfSync("sha256", SEQ, Buffer.from(PERPL_KEY_SALT), Buffer.from("143/1"), 32));
    expect(derivePerplKey(SEQ, 143, 1).secret).toEqual(rot);
  });
  it("rejects bad inputs", () => {
    expect(() => derivePerplKey(new Uint8Array(16), 143)).toThrow(/32 bytes/);
    expect(() => derivePerplKey(SEQ, 0)).toThrow(/chainId/);
  });
});
