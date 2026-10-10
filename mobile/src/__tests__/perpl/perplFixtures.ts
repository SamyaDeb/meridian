// Offline Perpl + chain for the N4 tests. Shapes follow core's recorded/synthetic fixtures (api-docs @ 25ab6e2:
// enrolment payload/enroll, GET /v1/trading/wallet; exchange views; ERC-20). No network, no real keys: the wallet is the
// fake-WebAuthn passkey (fixed synthetic PRF), the Perpl key is derived from it.
import * as ed from "@noble/ed25519";
import { allowForwardingTx, perplExchangeAbi, restCanonical } from "@meridian/core/perpl";
import { readPerplDeployment, type PerplDeployment } from "@meridian/core/meridian";
import { base64UrlDecode, hexToBytes, type FetchLike } from "@meridian/core/util";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import type { TxRequest, TxResult } from "../../wallet/sendTx";
import { fs, path, SRC_DIR } from "../node";

const repoJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(SRC_DIR, "..", "..", rel), "utf8"));

export const deployment = (chainId = 10143): PerplDeployment => readPerplDeployment(repoJson("deployments/perpl.json"), chainId);

/** typed data in Perpl's wire form (integers as strings), as core's enrol test and K3 saw it */
const typedData = (publicKey: string) => ({
  domain: { name: "Perpl", version: "1", chainId: "0x279f", verifyingContract: "0x0000000000000000000000000000000000000001" },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    ApiKey: [
      { name: "publicKey", type: "bytes32" },
      { name: "scopeMask", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
  primaryType: "ApiKey",
  message: { publicKey, scopeMask: "3", expiresAt: "0" },
});

type Acct = { id: number; b: bigint; lb: bigint; fw: boolean };

export class FakePerpl {
  /** wallets Perpl knows (enrol 404 otherwise) */
  profiles = new Set<string>();
  /** public key hex (no 0x) → { token, address } */
  keys = new Map<string, { token: string; address: string }>();
  accounts = new Map<string, Acct>();
  /** createAccount creates the profile (the hypothesis the phone run checks); false ⇒ enrol stays 404 */
  profileOnCreate = true;
  calls: { method: string; path: string; status: number; headers: Record<string, string> }[] = [];
  nextId = 1000;
  sn = 69_000_000;

  fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https:\/\/[^/]+\/api/, "");
    const r = this.answer(init.method, path, init.headers, init.body);
    this.calls.push({ method: init.method, path, status: r.status, headers: init.headers });
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)), headers: { get: () => null } };
  };

  private answer(method: string, path: string, h: Record<string, string>, body?: string): { status: number; body: unknown } {
    if (method === "POST" && path === "/v1/api-key/payload") {
      if (h.origin || h.Origin) return { status: 400, body: "Bad Request" }; // measured 9 Oct: a non-whitelisted Origin ⇒ 400
      const b = JSON.parse(body!) as { public_key: string };
      return { status: 200, body: { typed_data: typedData(b.public_key), mac: "mac-1" } };
    }
    if (method === "POST" && path === "/v1/api-key/enroll") {
      const b = JSON.parse(body!) as { address: string; typed_data: { message: { publicKey: string } } };
      const addr = b.address.toLowerCase();
      if (!this.profiles.has(addr)) return { status: 404, body: "Not Found" };
      const pk = b.typed_data.message.publicKey.replace(/^0x/, "");
      if (this.keys.has(pk)) return { status: 409, body: "public key already registered" };
      const token = `tok_${String(this.keys.size + 1).padStart(4, "0")}_ABCDEFGHIJKLMNOPQRSTUVWXYZ-_`;
      this.keys.set(pk, { token, address: addr });
      return { status: 200, body: { api_key: { api_key: token, address: b.address, scope_mask: 3, label: "Meridian mobile", origin: "", created_at: 1 } } };
    }
    if (method === "GET" && path === "/v1/trading/wallet") {
      const k = [...this.keys.entries()].find(([, v]) => v.token === h["X-API-Key"]);
      if (!k) return { status: 401, body: "unauthorized" };
      const canon = restCanonical({ chainId: 10143, method: "GET", target: path, timestampMs: Number(h["X-API-Timestamp"]), nonce: h["X-API-Nonce"]!, body: "" });
      if (!ed.verify(base64UrlDecode(h["X-API-Signature"]!), new TextEncoder().encode(canon), hexToBytes(k[0]))) return { status: 401, body: "bad signature" };
      const a = this.accounts.get(k[1].address);
      if (!a) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: { mt: 19, sn: this.sn, at: { b: this.sn }, addr: k[1].address, n: 0, fl: 0, as: [{ in: 1, id: a.id, fr: false, fw: a.fw, ft: 0, lfr: 0, b: a.b.toString(), lb: a.lb.toString() }] } };
    }
    return { status: 404, body: "no route" };
  }
}

/** ERC-20 + exchange state on "chain" for one collateral token. */
export class FakeChain {
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  decimals = 6;
  minOpen = 100_000_000n; // measured on 10143, 9 Oct 2026 (block 69,336,398)
  txs: { functionName: string; args: readonly unknown[]; from: Address }[] = [];
  /** throw after this many successful sends (simulates the app being killed between txs) */
  killAfter: number | undefined;
  private sent = 0;

  constructor(
    readonly perpl: FakePerpl,
    readonly dep: PerplDeployment,
  ) {}

  readContract = async (a: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const fn = a.functionName;
    if (fn === "decimals") return this.decimals;
    if (fn === "balanceOf") return this.balances.get(String(a.args![0]).toLowerCase()) ?? 0n;
    if (fn === "allowance") return this.allowances.get(String(a.args![0]).toLowerCase()) ?? 0n;
    if (fn === "getMinAccountOpenCNS") return this.minOpen;
    if (fn === "getAccountByAddr") {
      const acc = this.perpl.accounts.get(String(a.args![0]).toLowerCase());
      if (!acc) throw Object.assign(new Error('The contract function "getAccountByAddr" reverted.'), { name: "ContractFunctionExecutionError" });
      return { accountId: BigInt(acc.id), balanceCNS: acc.b, lockedBalanceCNS: acc.lb, frozen: 0, accountAddr: a.args![0], positions: [] };
    }
    throw new Error(`FakeChain: no ${fn}`);
  };

  sendWith = async (account: LocalAccount, req: TxRequest): Promise<TxResult> => {
    if (this.killAfter !== undefined && this.sent >= this.killAfter) throw new Error("app killed");
    const from = account.address.toLowerCase();
    if (req.to.toLowerCase() === this.dep.collateralToken.toLowerCase()) {
      const d = decodeFunctionData({ abi: erc20Abi, data: req.data! });
      if (d.functionName !== "approve") throw new Error("unexpected token call");
      this.allowances.set(from, d.args[1] as bigint);
      this.txs.push({ functionName: "approve", args: d.args, from: account.address });
    } else {
      const d = decodeFunctionData({ abi: perplExchangeAbi, data: req.data! });
      this.txs.push({ functionName: d.functionName, args: d.args ?? [], from: account.address });
      if (d.functionName === "createAccount" || d.functionName === "depositCollateral") {
        const amt = (d.args as readonly bigint[])[0]!;
        const allow = this.allowances.get(from) ?? 0n;
        if (allow < amt) throw new Error("ERC20: insufficient allowance");
        if (d.functionName === "createAccount" && amt < this.minOpen) throw new Error("below minimum");
        this.allowances.set(from, allow - amt);
        this.balances.set(from, (this.balances.get(from) ?? 0n) - amt);
        const prev = this.perpl.accounts.get(from);
        if (d.functionName === "createAccount") {
          this.perpl.accounts.set(from, { id: this.perpl.nextId++, b: amt, lb: 0n, fw: false });
          if (this.perpl.profileOnCreate) this.perpl.profiles.add(from);
        } else if (prev) prev.b += amt;
      } else if (d.functionName === "allowOrderForwarding") {
        const a = this.perpl.accounts.get(from);
        if (!a) throw new Error("no account");
        a.fw = (d.args as readonly boolean[])[0]!;
      }
    }
    this.sent++;
    const hash = keccak256(toHex(`${this.sent}:${req.data}`)) as Hex;
    return { hash, blockNumber: BigInt(69_000_000 + this.sent), gasUsed: 50_000n, gasLimit: 60_000n, gasEstimate: 50_000n, nonce: this.sent - 1 };
  };
}

export const forwardingData = (exchange: Address) => allowForwardingTx(exchange).data;
export const checksum = (a: string) => getAddress(a);
