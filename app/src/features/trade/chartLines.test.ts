import { describe, expect, it } from "vitest";
import type { AccountSummary } from "@/data/types";
import { accountLines, triggerLines } from "./chartLines";

const a = (size: bigint, liq: bigint): AccountSummary => ({ collateral: 0n, size, entryPrice: 27n, unrealizedPnl: 0n, pendingFunding: 0n, equity: 0n, initialMargin: 0n, maintenanceMargin: 0n, reservedOrderMargin: 0n, liquidationPrice: liq, liquidatable: false });

describe("accountLines", () => {
  it("entry + liquidation for a position, one line per resting order", () => {
    const l = accountLines(a(100n * 10n ** 18n, 20n), [{ id: 7n, isBid: true, tick: 1, priceWad: 25n, lots: 2n, flags: 0, placedBlock: 1n }]);
    expect(l.map((x) => [x.id, x.priceWad, x.tone])).toEqual([
      ["entry", 27n, "long"],
      ["liq", 20n, "warn"],
      ["o7", 25n, "long"],
    ]);
  });
  it("flat or unknown account ⇒ no position lines; no liq line when not computable", () => {
    expect(accountLines(a(0n, 0n), [])).toEqual([]);
    expect(accountLines(undefined, undefined)).toEqual([]);
    expect(accountLines(a(-1n, 0n), []).map((x) => x.id)).toEqual(["entry"]);
  });
});

describe("triggerLines", () => {
  it("one dashed line per trigger, toned by kind", () => {
    const l = triggerLines([
      { id: 1n, kind: "StopMarket", isBid: false, lots: 1n, triggerPriceWad: 9n, limitTick: 1, expiryBlock: 1n, tipToken: 0n },
      { id: 2n, kind: "TakeProfitMarket", isBid: false, lots: 1n, triggerPriceWad: 11n, limitTick: 1, expiryBlock: 1n, tipToken: 0n },
    ]);
    expect(l.map((x) => [x.id, x.tone, x.title])).toEqual([
      ["t1", "warn", "SL trigger"],
      ["t2", "long", "TP trigger"],
    ]);
    expect(triggerLines(undefined)).toEqual([]);
  });
});
