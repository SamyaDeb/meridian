// Kuru Flow route for the vault's spot leg (Phase 5 B4, CR-002). Mainnet Kuru MON/AUSD is dead (ARCHITECTURE R19),
// so the vault buys/sells MON through Kuru Flow: `rebalanceWithRoute(route)` where `route` is the calldata the
// KuruHedger sends to the KuruFlowEntrypoint (`flowEntrypoint.call(route)`, value 0, exact approval).
//
// API schema, documented sources only (fetched 30 Sep 2026):
// - POST https://ws.kuru.io/api/generate-token  body {"user_address"} → {"token", "expires_at", "rate_limit": {"rps": 1,
//   "burst": 1}}                                         https://docs.kuru.io/api-reference/generate-jwt-token
// - POST https://ws.kuru.io/api/quote, `Authorization: Bearer <token>` (or `X-API-Key`), body {"userAddress",
//   "tokenIn", "tokenOut", "amount" (base units, string), "slippageTolerance" (bps, 1–10000, required when
//   autoSlippage is false), "autoSlippage"} → {"type", "status": "success"|"error", "output", "message", "path",
//   "buildResponse", "gasPrices"}; errors {"error", "message"}  https://docs.kuru.io/api-reference/calculate-best-path-quote
// - `buildResponse` is typed only as "tx_builder.BuildResponse" in the docs. Kuru's own published client
//   (github.com/Kuru-Labs/kuru-trading-skills @ 6075030, scripts/kuru-trade.ts `extractBuildResponse` /
//   `normalizeBuildResponse`, references/kuru-flow.md) reads the transaction from `buildResponse` (or build_response,
//   transaction, tx, request, transactionRequest, also nested under data/result/quote/swap) with `to` (target,
//   destination), `data` (calldata, input) and `value`, and approves the entrypoint 0xb3e6…13cb as the token spender.
//   We mirror that extraction and REFUSE anything whose target isn't the hedger's flowEntrypoint or whose value ≠ 0.
//
// Amounts: the vault computes the spot amount onchain at execution (`_deployCost`, `_sellSpot`), so the keeper reads
// it from a `debug_traceCall` of `rebalanceWithRoute(0x00)` (the call to the hedger carries the exact amount; the
// dummy route then fails, which is fine for a trace) and quotes a little LESS (haircut): the route may pull at most
// the approved amount, and the hedger returns any leftover. The vault's minOut (index ∓ maxSlippage) and the
// hedger's balance-delta check stay the only price protection; the keeper's slippageTolerance is advisory.
import { type Address, type Hex, decodeFunctionData, getAddress, isHex } from "viem";
import { kuruHedgerAbi } from "./abi.js";

export const KURU_FLOW_API = "https://ws.kuru.io/api";

/** A frame of a `callTracer` trace (geth format, also served by Monad RPCs). */
export interface CallFrame {
  to?: string;
  input?: string;
  error?: string;
  calls?: CallFrame[];
}

export interface HedgerCall {
  kind: "buy" | "sell";
  amountIn: bigint; // buy: AUSD token units in; sell: WMON wei in
  minOut: bigint;
}

/** Every buySpot/sellSpot call to `hedger` in the trace, depth-first in execution order. */
export function findHedgerCalls(frame: CallFrame, hedger: Address): HedgerCall[] {
  const out: HedgerCall[] = [];
  const want = hedger.toLowerCase();
  const walk = (f: CallFrame): void => {
    if (f.to?.toLowerCase() === want && f.input !== undefined && isHex(f.input) && f.input.length >= 10) {
      try {
        const d = decodeFunctionData({ abi: kuruHedgerAbi, data: f.input as Hex });
        if (d.functionName === "buySpot") out.push({ kind: "buy", amountIn: d.args[0], minOut: d.args[1] });
        if (d.functionName === "sellSpot") out.push({ kind: "sell", amountIn: d.args[0], minOut: d.args[1] });
      } catch {
        // not a spot call (e.g. a view)
      }
    }
    for (const c of f.calls ?? []) walk(c);
  };
  walk(frame);
  return out;
}

/**
 * The amount to quote for one route used by every spot call of a rebalance: the smallest call's amount minus
 * `haircutBps` (rounds down), so each call's exact approval covers what the route pulls. null if the calls mix
 * buy and sell (one route can't serve both) or if there is no spot call.
 */
export function routeAmount(calls: HedgerCall[], haircutBps: bigint): { kind: "buy" | "sell"; amountIn: bigint } | null {
  if (calls.length === 0) return null;
  const kind = calls[0]!.kind;
  if (calls.some((c) => c.kind !== kind)) return null;
  const min = calls.reduce((m, c) => (c.amountIn < m ? c.amountIn : m), calls[0]!.amountIn);
  const amountIn = (min * (10_000n - haircutBps)) / 10_000n;
  return amountIn === 0n ? null : { kind, amountIn };
}

export interface QuoteRequest {
  userAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  slippageTolerance: number;
  autoSlippage: false;
}

/** Quote body per the docs: the hedger is the user (it holds and approves tokenIn, receives tokenOut). */
export function quoteRequest(p: {
  hedger: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
}): QuoteRequest {
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > 10_000) {
    throw new Error(`slippageTolerance must be an integer in [1, 10000] bps, got ${p.slippageBps}`);
  }
  return {
    userAddress: getAddress(p.hedger),
    tokenIn: getAddress(p.tokenIn),
    tokenOut: getAddress(p.tokenOut),
    amount: p.amountIn.toString(),
    slippageTolerance: p.slippageBps,
    autoSlippage: false,
  };
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const pick = (o: Obj, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** The transaction builder payload, with the same key variants as Kuru's published client. */
export function extractBuildResponse(resp: Obj): unknown {
  const direct = pick(resp, ["buildResponse", "build_response", "transaction", "tx", "request", "transactionRequest"]);
  if (direct !== undefined) return direct;
  for (const k of ["data", "result", "quote", "swap"]) {
    const nested = resp[k];
    if (isObj(nested)) {
      const found = extractBuildResponse(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export interface FlowRoute {
  to: Address;
  data: Hex;
  value: bigint;
  expectedOut: bigint | null; // the API's `output` (informational only)
}

/** Validate a quote response and turn it into the route bytes for `rebalanceWithRoute`. Throws on anything unsafe. */
export function parseQuote(resp: unknown, entrypoint: Address): FlowRoute {
  if (!isObj(resp)) throw new Error("Kuru quote: response is not an object");
  if (resp.status !== "success") {
    throw new Error(`Kuru quote: status ${String(resp.status ?? resp.error)}: ${String(resp.message ?? "")}`);
  }
  const b = extractBuildResponse(resp);
  if (!isObj(b)) throw new Error("Kuru quote: no buildResponse");
  const tx = isObj(pick(b, ["transaction", "tx", "request"])) ? (pick(b, ["transaction", "tx", "request"]) as Obj) : b;
  const to = pick(tx, ["to", "target", "destination"]);
  const data = pick(tx, ["data", "calldata", "input"]);
  const value = pick(tx, ["value"]);
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Kuru quote: missing transaction target");
  if (getAddress(to) !== getAddress(entrypoint)) {
    throw new Error(`Kuru quote: target ${to} is not the hedger's flowEntrypoint ${entrypoint}`);
  }
  if (typeof data !== "string" || !isHex(data) || data.length < 10) throw new Error("Kuru quote: calldata missing or not hex");
  const v = value === undefined || value === "" ? 0n : BigInt(value as string | number);
  if (v !== 0n) throw new Error(`Kuru quote: value ${v} ≠ 0 (the hedger sends no MON; tokenIn must be an ERC-20)`);
  const output = typeof resp.output === "string" && /^\d+$/.test(resp.output) ? BigInt(resp.output) : null;
  return { to: getAddress(to), data: data as Hex, value: 0n, expectedOut: output };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/** Thin API client: JWT cached until 60 s before `expires_at`, calls spaced ≥ 1.05 s apart (documented 1 rps). */
export class FlowClient {
  private jwt: string | undefined;
  private jwtExpiresAt = 0;
  private lastCallMs = 0;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly userAddress: Address,
    private readonly opts: {
      base?: string | undefined;
      staticJwt?: string | undefined;
      apiKey?: string | undefined;
      nowMs?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.jwt = opts.staticJwt;
    if (opts.staticJwt !== undefined) this.jwtExpiresAt = Number.MAX_SAFE_INTEGER;
  }

  private now(): number {
    return this.opts.nowMs?.() ?? Date.now();
  }

  private async post(path: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    const wait = this.lastCallMs + 1050 - this.now();
    if (wait > 0) await (this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    this.lastCallMs = this.now();
    const res = await this.fetchFn(`${this.opts.base ?? KURU_FLOW_API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.status !== 200) {
      const o = isObj(json) ? json : {};
      throw new Error(`Kuru ${path}: HTTP ${res.status} ${String(o.error ?? "")} ${String(o.message ?? "")}`.trim());
    }
    return json;
  }

  private async auth(): Promise<Record<string, string>> {
    if (this.opts.apiKey !== undefined) return { "X-API-Key": this.opts.apiKey };
    if (this.jwt === undefined || this.now() / 1000 > this.jwtExpiresAt - 60) {
      const r = await this.post("/generate-token", { user_address: this.userAddress }, {});
      if (!isObj(r) || typeof r.token !== "string") throw new Error("Kuru generate-token: no token");
      this.jwt = r.token;
      this.jwtExpiresAt = typeof r.expires_at === "number" ? r.expires_at : this.now() / 1000 + 300;
    }
    return { Authorization: `Bearer ${this.jwt}` };
  }

  async quote(body: QuoteRequest): Promise<unknown> {
    return this.post("/quote", body, await this.auth());
  }
}
