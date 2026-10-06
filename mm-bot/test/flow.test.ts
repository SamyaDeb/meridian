import { describe, expect, it } from "vitest";
import { type FlowConfig, type FlowIo, NO_ASK, decideTake, flowStep, limitTickFor, nextDelayMs, startupProblem } from "../src/flowplan.js";

/** Deterministic Rng cycling through fixed draws. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};
/** Small LCG for property-style sweeps (no Math.random in tests). */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
};

const CFG: FlowConfig = { minSec: 20, maxSec: 90, maxLots: 3n, maxSlippageBps: 30, positionCapLots: 10n };
const WAD = 10n ** 18n;
const TICK = 10n ** 14n; // 0.0001
const LOT = 100n * WAD;

describe("nextDelayMs: uniform wait in [FLOW_MIN_SEC, FLOW_MAX_SEC]", () => {
  it("hits both ends and stays inside", () => {
    expect(nextDelayMs(() => 0, 20, 90)).toBe(20_000);
    expect(nextDelayMs(() => 0.999999, 20, 90)).toBeLessThanOrEqual(90_000);
    const r = lcg(7);
    for (let i = 0; i < 1000; i++) {
      const d = nextDelayMs(r, 20, 90);
      expect(d).toBeGreaterThanOrEqual(20_000);
      expect(d).toBeLessThanOrEqual(90_000);
    }
  });
  it("tolerates swapped or negative bounds", () => {
    expect(nextDelayMs(() => 0, 90, 20)).toBe(20_000);
    expect(nextDelayMs(() => 0, -5, 0)).toBe(0);
  });
});

describe("decideTake: size and side bounds", () => {
  it("size is always in [1, FLOW_MAX_LOTS]", () => {
    const r = lcg(1);
    for (let i = 0; i < 2000; i++) {
      const t = decideTake(r, 0n, CFG);
      expect(t.lots >= 1n && t.lots <= CFG.maxLots).toBe(true);
    }
  });
  it("is unbiased when flat: both sides occur about equally", () => {
    const r = lcg(2);
    let buys = 0;
    for (let i = 0; i < 4000; i++) if (decideTake(r, 0n, CFG).isBid) buys++;
    expect(buys / 4000).toBeGreaterThan(0.45);
    expect(buys / 4000).toBeLessThan(0.55);
  });
  it("never takes |position| past the cap, on either side, from any start inside it", () => {
    const r = lcg(3);
    const cfg = { ...CFG, maxLots: 25n }; // a size larger than the cap must be clipped too
    for (let pos = -10n; pos <= 10n; pos++) {
      for (let i = 0; i < 200; i++) {
        const t = decideTake(r, pos, cfg);
        const after = pos + (t.isBid ? t.lots : -t.lots);
        expect(after <= 10n && after >= -10n, `pos ${pos} → ${after}`).toBe(true);
      }
    }
  });
});

describe("decideTake: inventory bias", () => {
  it("leans toward reducing as the position grows", () => {
    const share = (pos: bigint) => {
      const r = lcg(4);
      let buys = 0;
      for (let i = 0; i < 4000; i++) if (decideTake(r, pos, CFG).isBid) buys++;
      return buys / 4000;
    };
    expect(share(5n)).toBeLessThan(0.3); // long 5 of 10 ⇒ P(buy) = 0.25
    expect(share(-5n)).toBeGreaterThan(0.7);
    expect(share(9n)).toBeLessThan(share(5n));
  });
  it("at or past the cap: reduce-only, opposite side, at most |position| lots", () => {
    expect(decideTake(seq(0.99, 0), 10n, CFG)).toEqual({ isBid: false, lots: 3n, reduceOnly: true });
    expect(decideTake(seq(0.99, 0.99), -12n, CFG)).toEqual({ isBid: true, lots: 3n, reduceOnly: true });
    expect(decideTake(seq(0.99), 2n, { ...CFG, positionCapLots: 1n })).toEqual({ isBid: false, lots: 2n, reduceOnly: true });
  });
});

describe("limitTickFor: worst price within FLOW_MAX_SLIPPAGE_BPS of the index", () => {
  const index = 25n * 10n ** 15n; // 0.025
  it("buy rounds up, sell rounds down, both within bounds", () => {
    const b = limitTickFor(true, index, TICK, 30);
    const s = limitTickFor(false, index, TICK, 30);
    expect(BigInt(b) * TICK).toBeGreaterThanOrEqual((index * 10_030n) / 10_000n);
    expect(BigInt(b - 1) * TICK).toBeLessThan((index * 10_030n) / 10_000n);
    expect(BigInt(s) * TICK).toBeLessThanOrEqual((index * 9_970n) / 10_000n);
    expect(s).toBeGreaterThanOrEqual(1);
  });
  it("never returns tick 0 or the empty-ask sentinel", () => {
    expect(limitTickFor(false, 1n, TICK, 100)).toBe(1);
    expect(limitTickFor(true, 2n ** 255n, 1n, 100)).toBe(NO_ASK - 1);
  });
});

describe("startupProblem: separate, operator-listed key", () => {
  const flow = "0x00000000000000000000000000000000000000F1";
  it("refuses the MM's key", () => {
    expect(startupProblem({ flow, mm: flow.toLowerCase(), mmAccounts: [flow] })).toMatch(/different key/);
  });
  it("refuses an account not listed in mmAccounts (it would count as an external user)", () => {
    expect(startupProblem({ flow, mmAccounts: [] })).toMatch(/mmAccounts/);
    expect(startupProblem({ flow })).toMatch(/mmAccounts/);
  });
  it("accepts a listed key in any case", () => {
    expect(startupProblem({ flow, mm: "0x00000000000000000000000000000000000000a1", mmAccounts: [flow.toLowerCase()] })).toBeNull();
  });
});

function fakeIo(over: Partial<FlowIo> & { killSeq?: boolean[] } = {}): FlowIo & { sent: unknown[] } {
  const sent: unknown[] = [];
  const kills = over.killSeq ?? [false];
  let k = 0;
  return {
    sent,
    killed: () => kills[Math.min(k++, kills.length - 1)]!,
    index: over.index ?? (async () => 25n * 10n ** 15n),
    positionWad: over.positionWad ?? (async () => 0n),
    book: over.book ?? (async () => ({ bestBid: 249, bestAsk: 251 })),
    take:
      over.take ??
      (async (t) => {
        sent.push(t);
        return { status: "success" as const, gasLimit: 300_000n };
      }),
  };
}

describe("flowStep: kill file, stale oracle, empty book", () => {
  it("kill file present: no reads, no tx", async () => {
    let reads = 0;
    const io = fakeIo({ killSeq: [true], index: async () => (reads++, 1n) });
    expect(await flowStep(io, seq(0.1), CFG, LOT, TICK)).toEqual({ kind: "killed" });
    expect(reads).toBe(0);
    expect(io.sent).toEqual([]);
  });
  it("kill file appearing between the reads and the send still stops the take", async () => {
    const io = fakeIo({ killSeq: [false, true] });
    expect(await flowStep(io, seq(0.1), CFG, LOT, TICK)).toEqual({ kind: "killed" });
    expect(io.sent).toEqual([]);
  });
  it("stale oracle ⇒ skip without a tx", async () => {
    const io = fakeIo({ index: async () => null });
    expect(await flowStep(io, seq(0.1), CFG, LOT, TICK)).toEqual({ kind: "skip", reason: "oracle stale" });
    expect(io.sent).toEqual([]);
  });
  it("empty opposite side ⇒ skip (a market order would revert NoLiquidity)", async () => {
    const buy = fakeIo({ book: async () => ({ bestBid: 249, bestAsk: NO_ASK }) });
    expect(await flowStep(buy, seq(0, 0), CFG, LOT, TICK)).toEqual({ kind: "skip", reason: "no liquidity" });
    const sell = fakeIo({ book: async () => ({ bestBid: 0, bestAsk: 251 }) });
    expect(await flowStep(sell, seq(0, 0.99), CFG, LOT, TICK)).toEqual({ kind: "skip", reason: "no liquidity" });
  });
  it("best opposite level outside the slippage band ⇒ skip", async () => {
    const io = fakeIo({ book: async () => ({ bestBid: 100, bestAsk: 400 }) });
    expect(await flowStep(io, seq(0, 0), CFG, LOT, TICK)).toEqual({ kind: "skip", reason: "beyond slippage" });
  });
  it("otherwise sends exactly one bounded market order", async () => {
    const io = fakeIo({ positionWad: async () => 10n * LOT }); // at the cap ⇒ reduce
    const r = await flowStep(io, seq(0.5), CFG, LOT, TICK);
    expect(r.kind).toBe("take");
    expect(io.sent).toEqual([{ isBid: false, lots: 2n, reduceOnly: true, limitTick: limitTickFor(false, 25n * 10n ** 15n, TICK, 30) }]);
  });
});
