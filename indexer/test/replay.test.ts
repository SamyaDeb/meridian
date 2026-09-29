// End-to-end replay (brief C2 §2–§3, §6): every event the REAL perp stack emitted on anvil (DeployLocal +
// SmokeLocal + keeper + MM + a crash with eviction and IF-covered bad debt, ~22k blocks), recorded by
// scripts/record-anvil.mjs, is replayed through the indexer. Expectations are recomputed from the raw events and
// compared with the contract's own answers recorded at the same block (averageFundingApr, openInterest).
// The live `envio dev` run needs Docker and is pending; this replay covers the handlers on real chain data.
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import { createTestIndexer } from "envio";
import { CHAIN } from "./helpers.js";

type Item = {
  contract: string;
  event: string;
  srcAddress: `0x${string}`;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: `0x${string}` };
  params: Record<string, unknown>;
};
type Fixture = {
  atBlock: number;
  counts: Record<string, number>;
  expected: {
    averageFundingApr: Record<"1h" | "8h" | "24h", bigint | null>;
    checkpointApr1h: Array<{ block: number; slot: bigint; apr: bigint }>;
    longOI: bigint;
    shortOI: bigint;
    cumFunding: bigint;
    cumIndexTime: bigint;
  };
  items: Item[];
};

const fx = JSON.parse(readFileSync(new URL("./fixtures/anvil-e2e.json", import.meta.url), "utf8"), (_, v) =>
  typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
) as Fixture;

// Ownable's OwnershipTransferred is not indexed (not in config.yaml).
const items = fx.items.filter((i) => i.event !== "OwnershipTransferred");
const of = (contract: string, event: string) => items.filter((i) => i.contract === contract && i.event === event);
const CH = of("ClearingHouse", "FundingUpdated")[0]!.srcAddress;
const lc = (a: unknown) => String(a).toLowerCase();

let indexer: ReturnType<typeof createTestIndexer>;

beforeAll(async () => {
  indexer = createTestIndexer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await indexer.process({ chains: { [CHAIN]: { simulate: items as any } } });
}, 120_000);

describe("anvil E2E replay: every event type lands in the right entity", () => {
  it("the recording covers the perp event surface", () => {
    for (const k of [
      "ClearingHouse.Deposited",
      "ClearingHouse.Withdrawn",
      "ClearingHouse.FundingUpdated",
      "ClearingHouse.FundingCheckpoint",
      "ClearingHouse.FundingSettled",
      "ClearingHouse.PositionChanged",
      "ClearingHouse.Liquidated",
      "ClearingHouse.OrderMarginChanged",
      "ClearingHouse.FeesCollected",
      "ClearingHouse.RiskParamsUpdated",
      "ClearingHouse.FundingParamsUpdated",
      "ClearingHouse.PausedSet",
      "OrderBook.OrderPlaced",
      "OrderBook.OrderCancelled",
      "OrderBook.OrderEvicted",
      "OrderBook.Trade",
      "OracleAdapter.PriceUpdated",
      "InsuranceFund.Funded",
      "InsuranceFund.BadDebtCovered",
      "InsuranceFund.MarketAuthorized",
      "MarketFactory.MarketRegistered",
    ]) {
      expect(fx.counts[k], k).toBeGreaterThan(0);
    }
  });

  it("FundingTick: one per FundingUpdated block, F and G (cumIndexTime) exact", async () => {
    const ev = of("ClearingHouse", "FundingUpdated");
    const ticks = await indexer.FundingTick.getAll();
    expect(ticks.length).toBe(ev.length);
    const last = ev[ev.length - 1]!;
    const t = await indexer.FundingTick.getOrThrow(`${CH}-${last.block.number}`);
    expect(t.cumFunding).toBe(last.params.cumFunding);
    expect(t.cumIndexTime).toBe(last.params.cumIndexTime);
    expect(t.cumFunding).toBe(fx.expected.cumFunding);
    expect(t.cumIndexTime).toBe(fx.expected.cumIndexTime);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).fundingTicks).toBe(ev.length);
  });

  it("FundingCheckpoint: one entity per checkpoint event", async () => {
    expect((await indexer.FundingCheckpoint.getAll()).length).toBe(of("ClearingHouse", "FundingCheckpoint").length);
  });

  it("Order: placed / cancelled / evicted statuses", async () => {
    const orders = await indexer.Order.getAll();
    expect(orders.length).toBe(of("OrderBook", "OrderPlaced").length);
    const evicted = new Set(of("OrderBook", "OrderEvicted").map((i) => String(i.params.orderId)));
    expect(orders.filter((o) => o.status === "Evicted").map((o) => String(o.orderId)).sort()).toEqual([...evicted].sort());
    const cancelled = new Set(of("OrderBook", "OrderCancelled").map((i) => String(i.params.orderId)));
    expect(orders.filter((o) => o.status === "Cancelled").length).toBe(cancelled.size);
  });

  it("Trade + candles + protocol stats", async () => {
    const n = of("OrderBook", "Trade").length;
    expect((await indexer.Trade.getAll()).length).toBe(n);
    const candles = await indexer.Candle1m.getAll();
    expect(candles.reduce((s, c) => s + c.trades, 0)).toBe(n);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).trades).toBe(n);
  });

  it("Position / AccountMarket: sizes = last PositionChanged, Σq = 0, OI = the contract's", async () => {
    const last = new Map<string, bigint>();
    for (const i of of("ClearingHouse", "PositionChanged")) last.set(lc(i.params.account), i.params.newSize as bigint);
    const ams = await indexer.AccountMarket.getAll();
    let sumQ = 0n;
    let longs = 0n;
    for (const am of ams) {
      const want = last.get(lc(am.account_id)) ?? 0n;
      expect(am.size, am.id).toBe(want);
      sumQ += am.size;
      if (am.size > 0n) longs += am.size;
    }
    expect(sumQ).toBe(0n);
    expect(longs).toBe(fx.expected.longOI);
    const m = await indexer.Market.getOrThrow(CH);
    expect(m.openInterestLongWad).toBe(fx.expected.longOI);
    expect(m.openInterestShortWad).toBe(fx.expected.shortOI);
  });

  it("per-account funding paid = Σ FundingSettled.payment (brief C2 §3)", async () => {
    const paid = new Map<string, bigint>();
    for (const i of of("ClearingHouse", "FundingSettled")) {
      const a = lc(i.params.account);
      paid.set(a, (paid.get(a) ?? 0n) + (i.params.payment as bigint));
    }
    for (const am of await indexer.AccountMarket.getAll()) {
      expect(am.fundingPaid, am.id).toBe(paid.get(lc(am.account_id)) ?? 0n);
    }
  });

  it("Liquidation + bad debt + insurance fund", async () => {
    const liq = of("ClearingHouse", "Liquidated");
    const ents = await indexer.Liquidation.getAll();
    expect(ents.length).toBe(liq.length);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).liquidations).toBe(liq.length);
    expect(ents.filter((e) => e.badDebt > 0n).length).toBe(liq.filter((i) => (i.params.badDebt as bigint) > 0n).length);
    const covered = of("InsuranceFund", "BadDebtCovered");
    expect((await indexer.BadDebtEvent.getAll()).length).toBeGreaterThanOrEqual(covered.length);
  });

  it("Deposited / Withdrawn / oracle prices / admin events", async () => {
    const dep = new Map<string, bigint>();
    for (const i of of("ClearingHouse", "Deposited")) dep.set(lc(i.params.account), (dep.get(lc(i.params.account)) ?? 0n) + (i.params.amountToken as bigint));
    for (const am of await indexer.AccountMarket.getAll()) expect(am.depositedToken, am.id).toBe(dep.get(lc(am.account_id)) ?? 0n);
    const wd = of("ClearingHouse", "Withdrawn").reduce((s, i) => s + (i.params.amountToken as bigint), 0n);
    expect((await indexer.AccountMarket.getAll()).reduce((s, a) => s + a.withdrawnToken, 0n)).toBe(wd);
    expect((await indexer.OraclePrice.getAll()).length).toBe(of("OracleAdapter", "PriceUpdated").length);
    const admin = (await indexer.AdminEvent.getAll()).map((e) => e.name);
    for (const n of ["RiskParamsUpdated", "FundingParamsUpdated", "PausedSet", "FeesCollected"]) expect(admin, n).toContain(n);
  });
});

describe("realized APR = the contract's averageFundingApr at the same block (brief C2 §3)", () => {
  it("1 h window at the recording's last funding block; 8 h / 24 h null on both sides (not enough history)", async () => {
    const m = await indexer.Market.getOrThrow(CH);
    expect(fx.expected.averageFundingApr["1h"]).not.toBeNull();
    expect(m.realizedApr1hWad).toBe(fx.expected.averageFundingApr["1h"]);
    expect(fx.expected.averageFundingApr["8h"]).toBeNull();
    expect(m.realizedApr8hWad ?? null).toBeNull();
    expect(m.realizedApr24hWad ?? null).toBeNull();
    // 10.95% APR interest floor on a balanced book (MATH_SPEC §1.3), within the δ-ramp and mark rounding
    expect(Number(m.realizedApr1hWad) / 1e18).toBeCloseTo(0.1095, 3);
  });

  it("historical checkpoints: FundingCheckpoint.realizedApr1hWad = averageFundingApr(12,000) at that block", async () => {
    for (const c of fx.expected.checkpointApr1h) {
      const cp = await indexer.FundingCheckpoint.getOrThrow(`${CH}-${Math.floor(c.block / 200)}`);
      expect(cp.realizedApr1hWad, `block ${c.block}`).toBe(c.apr);
    }
  });
});
