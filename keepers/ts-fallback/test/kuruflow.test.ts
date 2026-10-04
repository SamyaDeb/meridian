import { describe, expect, it } from "vitest";
import { type Address, encodeFunctionData } from "viem";
import { kuruHedgerAbi } from "../src/abi.js";
import {
  type CallFrame,
  type FetchLike,
  FlowClient,
  extractBuildResponse,
  findHedgerCalls,
  parseQuote,
  quoteRequest,
  routeAmount,
} from "../src/kuruflow.js";
import fixture from "./fixtures/kuru-quote.synthetic.json" with { type: "json" };

// Mainnet addresses from contracts/script/config/143.json (ARCHITECTURE R16, R9).
const ENTRY = "0xb3e6778480b2E488385E8205eA05E20060B813cb" as Address;
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
const HEDGER = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;

const buy = (q: bigint, m: bigint) =>
  encodeFunctionData({ abi: kuruHedgerAbi, functionName: "buySpot", args: [q, m, "0x00"] });
const sell = (b: bigint, m: bigint) =>
  encodeFunctionData({ abi: kuruHedgerAbi, functionName: "sellSpot", args: [b, m, "0x00"] });

describe("findHedgerCalls: the vault's exact spot amount from a callTracer trace", () => {
  it("finds a nested buySpot even when the dummy route made it revert", () => {
    const trace: CallFrame = {
      to: VAULT,
      input: "0xdeadbeef",
      error: "execution reverted",
      calls: [
        { to: "0x3333333333333333333333333333333333333333", input: "0x" },
        { to: HEDGER.toUpperCase().replace("0X", "0x"), input: buy(1_140_000_000n, 38_000n * 10n ** 18n), error: "RouteCallFailed" },
      ],
    };
    expect(findHedgerCalls(trace, HEDGER)).toEqual([{ kind: "buy", amountIn: 1_140_000_000n, minOut: 38_000n * 10n ** 18n }]);
  });

  it("ignores views and other contracts; keeps execution order", () => {
    const trace: CallFrame = {
      to: VAULT,
      calls: [
        { to: HEDGER, input: encodeFunctionData({ abi: kuruHedgerAbi, functionName: "baseToken" }) },
        { to: HEDGER, input: sell(5n * 10n ** 21n, 1n) },
        { to: VAULT, calls: [{ to: HEDGER, input: sell(3n * 10n ** 21n, 1n) }] },
      ],
    };
    expect(findHedgerCalls(trace, HEDGER).map((c) => c.amountIn)).toEqual([5n * 10n ** 21n, 3n * 10n ** 21n]);
  });
});

describe("routeAmount", () => {
  it("haircut below the smallest call, rounds down", () => {
    const r = routeAmount(
      [
        { kind: "sell", amountIn: 10_000n, minOut: 0n },
        { kind: "sell", amountIn: 7_777n, minOut: 0n },
      ],
      10n,
    );
    expect(r).toEqual({ kind: "sell", amountIn: 7_769n }); // 7,777 × 0.999 = 7,769.2
  });
  it("null for no call, mixed directions, or a zero amount", () => {
    expect(routeAmount([], 10n)).toBeNull();
    expect(routeAmount([{ kind: "buy", amountIn: 5n, minOut: 0n }, { kind: "sell", amountIn: 5n, minOut: 0n }], 10n)).toBeNull();
    expect(routeAmount([{ kind: "buy", amountIn: 1n, minOut: 0n }], 10n)).toBeNull();
  });
});

describe("quoteRequest: documented body", () => {
  it("hedger is the user, amount as a decimal string, explicit slippage", () => {
    expect(quoteRequest({ hedger: HEDGER, tokenIn: AUSD, tokenOut: WMON, amountIn: 1_000_000n, slippageBps: 50 })).toEqual({
      userAddress: HEDGER,
      tokenIn: AUSD,
      tokenOut: WMON,
      amount: "1000000",
      slippageTolerance: 50,
      autoSlippage: false,
    });
  });
  it("rejects slippage outside [1, 10000] bps", () => {
    expect(() => quoteRequest({ hedger: HEDGER, tokenIn: AUSD, tokenOut: WMON, amountIn: 1n, slippageBps: 0 })).toThrow();
    expect(() => quoteRequest({ hedger: HEDGER, tokenIn: AUSD, tokenOut: WMON, amountIn: 1n, slippageBps: 10_001 })).toThrow();
  });
});

describe("parseQuote: only an entrypoint call with value 0 becomes a route", () => {
  it("accepts the fixture", () => {
    const r = parseQuote(fixture, ENTRY);
    expect(r.to).toBe(ENTRY);
    expect(r.data.startsWith("0x12345678")).toBe(true);
    expect(r.value).toBe(0n);
    expect(r.expectedOut).toBe(36_640n * 10n ** 18n);
  });
  it("key variants from Kuru's client (nested / snake_case / calldata)", () => {
    const v = { status: "success", result: { build_response: { target: ENTRY.toLowerCase(), calldata: "0xabcdef0123" } } };
    expect(extractBuildResponse(v)).toEqual({ target: ENTRY.toLowerCase(), calldata: "0xabcdef0123" });
    expect(parseQuote(v, ENTRY).data).toBe("0xabcdef0123");
  });
  it("refuses a foreign target, a non-zero value, missing calldata, or an error status", () => {
    const base = { status: "success", buildResponse: { to: ENTRY, data: "0xabcdef0123", value: "0" } };
    expect(() => parseQuote({ ...base, buildResponse: { ...base.buildResponse, to: WMON } }, ENTRY)).toThrow(/not the hedger/);
    expect(() => parseQuote({ ...base, buildResponse: { ...base.buildResponse, value: "1" } }, ENTRY)).toThrow(/value/);
    expect(() => parseQuote({ ...base, buildResponse: { to: ENTRY } }, ENTRY)).toThrow(/calldata/);
    expect(() => parseQuote({ status: "error", message: "no route" }, ENTRY)).toThrow(/no route/);
    expect(() => parseQuote({ status: "success" }, ENTRY)).toThrow(/buildResponse/);
  });
});

describe("FlowClient", () => {
  it("gets a JWT once, sends Bearer, spaces calls ≥ 1.05 s (1 rps)", async () => {
    let t = 1_790_000_000_000;
    const slept: number[] = [];
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const json = url.endsWith("/generate-token") ? { token: "jwt-1", expires_at: t / 1000 + 3600 } : fixture;
      return { status: 200, json: async () => json };
    };
    const c = new FlowClient(fetchFn, HEDGER, { nowMs: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    const body = quoteRequest({ hedger: HEDGER, tokenIn: AUSD, tokenOut: WMON, amountIn: 5n, slippageBps: 50 });
    await c.quote(body);
    await c.quote(body);
    expect(calls.map((x) => x.url.split("/api")[1])).toEqual(["/generate-token", "/quote", "/quote"]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ user_address: HEDGER });
    expect(calls[1]!.headers.Authorization).toBe("Bearer jwt-1");
    expect(slept.every((ms) => ms > 0 && ms <= 1050)).toBe(true);
    expect(slept.length).toBe(2);
  });
  it("uses X-API-Key when given (no token call) and surfaces API errors", async () => {
    const fetchFn: FetchLike = async () => ({ status: 400, json: async () => ({ error: "missing_required_fields", message: "amount" }) });
    const c = new FlowClient(fetchFn, HEDGER, { apiKey: "k", sleep: async () => {} });
    await expect(
      c.quote(quoteRequest({ hedger: HEDGER, tokenIn: AUSD, tokenOut: WMON, amountIn: 5n, slippageBps: 50 })),
    ).rejects.toThrow(/HTTP 400 missing_required_fields amount/);
  });
});
