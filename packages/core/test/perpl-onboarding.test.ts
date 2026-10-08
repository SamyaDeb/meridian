import { decodeFunctionData, erc20Abi, getAddress, recoverTypedDataAddress, type Address, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_ORDER,
  ORDER_STATUS_REASON_NAMES,
  PerplHttpError,
  allowForwardingTx,
  approveCollateralTx,
  createAccountTx,
  createSignedRest,
  depositCollateralTx,
  detectOnboarding,
  enrollApiKey,
  explainClose,
  explainHttp,
  explainOrder,
  observeWallet,
  parseSecret,
  perplExchangeAbi,
  popSignature,
  toTypedDataDefinition,
  type Account,
} from "../src/perpl";
import { edVerify } from "../src/perpl/ed";
import { hexToBytes } from "../src/util/bytes";
import { FakeClock, fakeFetch, fixtureLines, repoJson, seqBytes } from "./helpers";

const EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc" as Address; // deployments/perpl.json chains.10143.exchange
const TOKEN = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc" as Address; // deployments/perpl.json chains.10143.collateralToken
const acct = (o: Partial<Account> = {}): Account => ({ in: 12, id: 969, fr: false, fw: true, ft: 0, lfr: 0, b: "5000000000", lb: "0", ...o });

describe("Perpl ABI fragments equal the vendored exchange ABI", () => {
  it("every entry is byte-identical to indexer/abis/PerplExchange.json", () => {
    const full = repoJson<{ type: string; name?: string }[]>("indexer/abis/PerplExchange.json");
    for (const e of perplExchangeAbi) expect(full.find((x) => x.type === e.type && x.name === e.name)).toEqual(e);
  });
});

describe("onboarding detector: NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY", () => {
  it("each documented state, from what the API/chain answered", () => {
    expect(detectOnboarding({ apiKey: undefined, wallet: undefined }).step).toBe("NO_KEY");
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: false, status: 401 } })).toMatchObject({ step: "NO_KEY", next: { type: "enroll-key" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: false, status: 404 } })).toMatchObject({ step: "KEY_ENROLLED", next: { type: "create-account" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: true, accounts: [] } }).step).toBe("KEY_ENROLLED");
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: true, accounts: [acct({ fw: false })] } })).toMatchObject({ step: "ACCOUNT_CREATED", next: { type: "allow-forwarding" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: true, accounts: [acct({ b: "100", lb: "100" })] } })).toMatchObject({ step: "FORWARDING_ON", next: { type: "deposit" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: true, accounts: [acct()] } })).toMatchObject({ step: "READY", next: { type: "none" } });
    expect(ONBOARDING_ORDER).toEqual(["NO_KEY", "KEY_ENROLLED", "ACCOUNT_CREATED", "FORWARDING_ON", "READY"]);
  });
  it("ambiguous reads never move the step backwards past what is certain; chain beats a lagging API", () => {
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: false, status: 503 } })).toMatchObject({ step: "KEY_ENROLLED", next: { type: "retry" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: false, status: 404 }, chainAccountId: 969n })).toMatchObject({ step: "ACCOUNT_CREATED", next: { type: "retry" } });
    expect(detectOnboarding({ apiKey: "k", wallet: { ok: false, status: 404 }, chainAccountId: 0n }).step).toBe("KEY_ENROLLED");
  });
  it("the recorded K3 hedge wallet (account 969, fw true, 5,000 AUSD free) is READY", async () => {
    const wallet = fixtureLines("perpl/testnet/trading/trading-session.jsonl")[0]!.frame;
    const rest = createSignedRest({ apiUrl: "https://testnet.perpl.xyz/api", chainId: 10143, apiKey: "tok", secret: parseSecret("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"), random: seqBytes, clock: new FakeClock(), fetchFn: fakeFetch(() => ({ status: 200, body: wallet })) });
    expect(detectOnboarding({ apiKey: "tok", wallet: await observeWallet(rest) })).toMatchObject({ step: "READY", account: { id: 969 } });
    const r404 = createSignedRest({ apiUrl: "https://testnet.perpl.xyz/api", chainId: 10143, apiKey: "tok", secret: parseSecret("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"), random: seqBytes, clock: new FakeClock(), fetchFn: fakeFetch(() => ({ status: 404, body: { error: "not found" } })) });
    expect(await observeWallet(r404)).toEqual({ ok: false, status: 404 });
  });
});

describe("onboarding tx builders return viem call data (the app sends them)", () => {
  it("approve → createAccount(min) → allowOrderForwarding(true) → depositCollateral", () => {
    const a = approveCollateralTx(TOKEN, EXCHANGE, 100_000_000n);
    expect(a.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data })).toEqual({ functionName: "approve", args: [getAddress(EXCHANGE), 100_000_000n] });
    const c = createAccountTx(EXCHANGE, 100_000_000n, 100_000_000n);
    expect(decodeFunctionData({ abi: perplExchangeAbi, data: c.data })).toEqual({ functionName: "createAccount", args: [100_000_000n] });
    expect(() => createAccountTx(EXCHANGE, 99_999_999n, 100_000_000n)).toThrow(/below the minimum/);
    expect(decodeFunctionData({ abi: perplExchangeAbi, data: allowForwardingTx(EXCHANGE).data })).toEqual({ functionName: "allowOrderForwarding", args: [true] });
    expect(decodeFunctionData({ abi: perplExchangeAbi, data: depositCollateralTx(EXCHANGE, 5n).data })).toEqual({ functionName: "depositCollateral", args: [5n] });
    expect([a, c].every((t) => t.value === 0n)).toBe(true);
  });
});

describe("enrolment (integrations.md Step 2–3, K3 perpl-enroll.ts as a flow)", () => {
  const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1, test-only
  const secret = parseSecret("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // RFC 8032 TEST 1
  // typed data in Perpl's wire form (integers as strings), as K3 saw on testnet
  const td = {
    domain: { name: "Perpl", version: "1", chainId: "0x279f", verifyingContract: "0x0000000000000000000000000000000000000001" },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      ApiKey: [{ name: "publicKey", type: "bytes32" }, { name: "scopeMask", type: "uint32" }, { name: "expiresAt", type: "uint64" }],
    },
    primaryType: "ApiKey",
    message: { publicKey: "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", scopeMask: "3", expiresAt: "0" },
  };
  it("integers coerced by declared type; EIP712Domain dropped", () => {
    const def = toTypedDataDefinition(td) as unknown as { domain: { chainId: bigint }; types: Record<string, unknown>; message: { scopeMask: bigint } };
    expect(def.domain.chainId).toBe(10143n);
    expect(def.message.scopeMask).toBe(3n);
    expect(def.types.EIP712Domain).toBeUndefined();
  });
  it("payload → wallet EIP-712 signature + Ed25519 PoP over the digest → enroll; token returned; Origin only when given", async () => {
    const f = fakeFetch((url, init) => {
      if (url.endsWith("/v1/api-key/payload")) return { status: 200, body: { typed_data: td, mac: "m" } };
      const b = JSON.parse(init.body!) as Record<string, unknown>;
      return { status: 200, body: { api_key: { api_key: "opaque-token", address: b.address, scope_mask: 3, label: "Meridian", origin: "", created_at: 1 } } };
    });
    const info = await enrollApiKey({ apiUrl: "https://testnet.perpl.xyz/api/", chainId: 10143, address: wallet.address, secret, label: "Meridian", signTypedData: (d) => wallet.signTypedData(d as never), fetchFn: f });
    expect(info.api_key).toBe("opaque-token");
    const p = JSON.parse(f.calls[0]!.init.body!) as Record<string, unknown>;
    expect(p).toEqual({ chain_id: 10143, address: wallet.address, public_key: "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", scope_mask: 3, label: "Meridian" });
    expect(f.calls[0]!.init.headers.origin).toBeUndefined();
    const e = JSON.parse(f.calls[1]!.init.body!) as { signature: `0x${string}`; pop_signature: `0x${string}`; mac: string };
    expect(e.mac).toBe("m");
    const def = toTypedDataDefinition(td);
    expect(await recoverTypedDataAddress({ ...(def as TypedDataDefinition), signature: e.signature })).toBe(wallet.address);
    expect(e.pop_signature).toBe(popSignature(def, secret));
    const { hashTypedData } = await import("viem");
    expect(edVerify(hexToBytes(e.pop_signature), hexToBytes(hashTypedData(def)), hexToBytes(p.public_key as string))).toBe(true);
  });
  it("409 (key already registered) surfaces as PerplHttpError with the status", async () => {
    const f = fakeFetch((url) => (url.endsWith("/payload") ? { status: 200, body: { typed_data: td, mac: "m" } } : { status: 409, body: "public key already registered" }));
    const err = await enrollApiKey({ apiUrl: "https://x/api", chainId: 10143, address: wallet.address, secret, label: "L", signTypedData: (d) => wallet.signTypedData(d as never), fetchFn: f, origin: "https://meridian-testnet.vercel.app" }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PerplHttpError);
    expect((err as PerplHttpError).status).toBe(409);
    expect(f.calls[0]!.init.headers.origin).toBe("https://meridian-testnet.vercel.app");
  });
});

describe("plain-English errors (types.md tables)", () => {
  it("all 70 documented OrderStatusReason values are named; forwarding / balance / IOC read plainly", () => {
    expect(Object.keys(ORDER_STATUS_REASON_NAMES)).toHaveLength(70);
    expect(ORDER_STATUS_REASON_NAMES[34]).toBe("OrderForwardingNotAllowed");
    expect(explainOrder({ st: 7, sr: 34 })).toMatch(/One-click trading/);
    expect(explainOrder({ st: 7, sr: 1 })).toMatch(/Not enough free AUSD/);
    expect(explainOrder({ st: 4, sr: 16 })).toMatch(/rest was cancelled/);
    expect(explainOrder({ st: 7, sr: 44, fr: 7 })).toMatch(/fresh reference price/); // fr wins over sr
    expect(explainOrder({ st: 7, sr: 63 })).toBe("Perpl rejected the order (PriceSetDuringTriggerExec).");
    expect(explainOrder({ st: 7, sr: 999 })).toMatch(/Unknown\(999\)/);
  });
  it("HTTP and close codes", () => {
    expect(explainHttp(401)).toMatch(/signature/);
    expect(explainHttp(404)).toMatch(/No Perpl exchange account/);
    expect(explainHttp(502)).toMatch(/server error/);
    expect(explainClose(1008, "too many connections")).toMatch(/4 max/);
    expect(explainClose(3401)).toMatch(/sign-in/);
  });
});
