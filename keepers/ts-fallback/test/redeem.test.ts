import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { parseQuote } from "../src/kuruflow.js";
import {
  FulfilRetry,
  MAX_BATCH,
  PAGE_AFTER_FAILURES,
  RedeemQueue,
  classifyFulfilError,
  fulfilRoutePlan,
  nextLogRange,
} from "../src/redeem.js";
import live from "./fixtures/kuru-quote.live-buy.json" with { type: "json" };

const ENTRY = "0xb3e6778480b2E488385E8205eA05E20060B813cb" as Address; // R16

describe("RedeemQueue: ids only from events, oldest first, ≤ MAX_BATCH", () => {
  it("batches the oldest 32 and forgets cancelled / fulfilled ids", () => {
    const q = new RedeemQueue();
    for (let i = 40n; i >= 1n; i--) q.requested(i, 1000n + i); // logs may arrive out of order across spans
    expect(q.size).toBe(40);
    const b = q.batch();
    expect(b.length).toBe(MAX_BATCH);
    expect(b[0]).toBe(1n);
    expect(b[31]).toBe(32n);
    q.done(1n); // fulfilled
    q.done(5n); // cancelled
    expect(q.batch()).not.toContain(1n);
    expect(q.batch()).not.toContain(5n);
    expect(q.batch().at(-1)).toBe(34n);
  });

  it("a duplicate RedeemRequested (re-scanned span) keeps the first block", () => {
    const q = new RedeemQueue();
    q.requested(7n, 100n);
    q.requested(7n, 150n);
    expect(q.size).toBe(1);
    expect(q.oldestPendingBlocks(130n)).toBe(30n);
  });

  it("oldestPendingBlocks is 0 when empty", () => {
    expect(new RedeemQueue().oldestPendingBlocks(10n)).toBe(0n);
  });
});

describe("fulfilRoutePlan", () => {
  it("empty route when idle covers the batch (no spot leg)", () => {
    expect(fulfilRoutePlan({ chainId: 143, spotToSell: 0n, haircutBps: 10n, mockHedger: false })).toEqual({
      kind: "empty",
      reason: "idle covers the batch",
    });
  });
  it("empty route on testnet (labelled mock hedger ignores it)", () => {
    expect(fulfilRoutePlan({ chainId: 10143, spotToSell: 5n * 10n ** 18n, haircutBps: 10n, mockHedger: true }).kind).toBe("empty");
  });
  it("mainnet quotes the previewed base minus the haircut (rounds down)", () => {
    expect(fulfilRoutePlan({ chainId: 143, spotToSell: 3_359_731_298_708_121_880_925n, haircutBps: 5n, mockHedger: false })).toEqual({
      kind: "quote",
      amountIn: 3_358_051_433_058_767_819_984n,
    });
  });
});

describe("retry / paging policy", () => {
  it("classifies route-fixable reverts", () => {
    expect(classifyFulfilError(new Error('execution reverted: custom error RouteCallFailed()'))).toBe("route");
    expect(classifyFulfilError(new Error("The contract function reverted with SlippageExceeded()"))).toBe("route");
    expect(classifyFulfilError(new Error("Kuru /quote: HTTP 429"))).toBe("route");
    expect(classifyFulfilError(new Error("OnlyKeeper()"))).toBe("other");
  });
  it("pages once when the streak reaches 3, resets on success", () => {
    const r = new FulfilRetry();
    const pages = [r.failed("route"), r.failed("route"), r.failed("other"), r.failed("route")];
    expect(PAGE_AFTER_FAILURES).toBe(3);
    expect(pages).toEqual([false, false, true, false]);
    r.ok();
    expect(r.consecutiveFailures).toBe(0);
    expect(r.totalFailures).toBe(4);
    expect([r.failed("route"), r.failed("route"), r.failed("route")]).toEqual([false, false, true]);
  });
});

describe("nextLogRange: bounded log span (free-tier RPC)", () => {
  it("walks forward ≤ span blocks and stops at the head", () => {
    expect(nextLogRange(99n, 1000n, 10n)).toEqual({ from: 100n, to: 109n });
    expect(nextLogRange(995n, 1000n, 10n)).toEqual({ from: 996n, to: 1000n });
    expect(nextLogRange(1000n, 1000n, 10n)).toBeNull();
  });
});

describe("parseQuote on a LIVE Kuru Flow response (recorded 7 Oct 2026, mainnet, read-only)", () => {
  it("accepts calldata without the 0x prefix (the live shape) and keeps the entrypoint check", () => {
    const r = parseQuote(live, ENTRY);
    expect(r.to).toBe(ENTRY);
    expect(r.data.startsWith("0x")).toBe(true);
    expect(r.data.slice(2)).toBe((live as { transaction: { calldata: string } }).transaction.calldata);
    expect(r.value).toBe(0n);
    expect(r.expectedOut).toBe(BigInt((live as { output: string }).output));
    expect(() => parseQuote(live, "0x0000000000000000000000000000000000000001")).toThrow(/not the hedger's flowEntrypoint/);
  });
});
