// One-time: enroll a Perpl API key for the hedge wallet, programmatically (api-docs integrations.md, 7 Oct 2026):
//   1. generate an Ed25519 key pair locally;
//   2. POST /v1/api-key/payload → EIP-712 typed data + mac;
//   3. sign it with the wallet (secp256k1 EIP-712) and prove possession of the API key (Ed25519 over the EIP-712 digest);
//   4. POST /v1/api-key/enroll → the opaque X-API-Key token.
// Reads the wallet key from the env (PERPL_HEDGE_WALLET_KEY), APPENDS PERPL_API_KEY / PERPL_API_KEY_SECRET to ENV_FILE
// (default ../.env, gitignored) and prints only non-secret key info. No Origin header is sent: we don't claim one.
//   cd mm-bot && PERPL_HEDGE_WALLET_KEY=… node_modules/.bin/tsx scripts/perpl-enroll.ts [label] [scope_mask=3]
import { appendFileSync, readFileSync } from "node:fs";
import * as ed from "@noble/ed25519";
import { hashTypedData, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.PERPL_API_URL ?? "https://testnet.perpl.xyz/api";
const CHAIN_ID = Number(process.env.PERPL_CHAIN_ID ?? "10143");
if (CHAIN_ID !== 10143 || !API.startsWith("https://testnet.perpl.xyz/")) throw new Error("testnet only (10143, testnet.perpl.xyz)");
const envFile = process.env.ENV_FILE ?? new URL("../../.env", import.meta.url).pathname;
const wk = process.env.PERPL_HEDGE_WALLET_KEY as Hex | undefined;
if (!wk) throw new Error("PERPL_HEDGE_WALLET_KEY not set");
if (/^PERPL_API_KEY=.+/m.test(readFileSync(envFile, "utf8"))) throw new Error(`${envFile} already has PERPL_API_KEY: refusing to enroll a second key`);
const account = privateKeyToAccount(wk);
const label = process.argv[2] ?? "meridian-mm-hedge";
const scope = Number(process.argv[3] ?? "3");

const secret = ed.utils.randomSecretKey();
const publicKey = `0x${Buffer.from(await ed.getPublicKeyAsync(secret)).toString("hex")}`;
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
};

const payload = await post("/v1/api-key/payload", { chain_id: CHAIN_ID, address: account.address, public_key: publicKey, scope_mask: scope, label });
const td = payload.typed_data as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
console.log("signing (EIP-712):", JSON.stringify({ domain: td.domain, primaryType: td.primaryType, message: td.message }, null, 1));
const { EIP712Domain: domainTypes, ...types } = td.types;
console.log("types:", JSON.stringify(td.types));
// Perpl serialises integers as strings ("0x279f", "0"): coerce every (u)intN field to bigint by its declared type, so the
// EIP-712 hash is over the numbers, not the strings.
const coerce = (fields: { name: string; type: string }[] | undefined, o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^u?int\d*$/.test(fields?.find((f) => f.name === k)?.type ?? "") && typeof v === "string" ? BigInt(v) : v]));
const def = { domain: coerce(domainTypes, td.domain), types, primaryType: td.primaryType, message: coerce(types[td.primaryType], td.message) } as unknown as TypedDataDefinition;
const signature = await account.signTypedData(def);
const digest = hashTypedData(def); // keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
const pop = `0x${Buffer.from(await ed.signAsync(Buffer.from(digest.slice(2), "hex"), secret)).toString("hex")}`;
const res = await post("/v1/api-key/enroll", { chain_id: CHAIN_ID, address: account.address, typed_data: payload.typed_data, mac: payload.mac, signature, pop_signature: pop });
const info = res.api_key as { api_key: string; scope_mask: number; label: string; origin: string; created_at: number; address: string };
appendFileSync(envFile, `PERPL_API_KEY=${info.api_key}\nPERPL_API_KEY_SECRET=${Buffer.from(secret).toString("hex")}\n`);
console.log("enrolled:", { address: info.address, scope_mask: info.scope_mask, label: info.label, origin: info.origin, created_at: new Date(info.created_at).toISOString(), publicKey, savedTo: envFile });
