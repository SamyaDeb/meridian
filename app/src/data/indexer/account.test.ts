import { describe, expect, it } from "vitest";
import { ACCOUNT_HISTORY_QUERY, parseAccountHistory } from "./account";

const ME = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const t = (maker: string, taker: string, takerIsBid: boolean) => ({ id: "1-0", maker, taker, takerIsBid, priceWad: "27046000000000000", sizeWad: "100000000000000000000", notionalWad: "2704600000000000000", block: "10", timestamp: "1700000000", txHash: "0xab" });

describe("indexer account history", () => {
  it("side from the account's view: taker bid = buy, maker on a taker bid = sell", () => {
    const d = { Trade: [t("0xmm", ME.toLowerCase(), true), t(ME, "0xother", true), t(ME, "0xother", false)], Order: [], Liquidation: [] };
    const h = parseAccountHistory(d, ME);
    expect(h.trades.map((x) => [x.isMaker, x.isBuy])).toEqual([
      [false, true],
      [true, false],
      [true, true],
    ]);
    expect(h.trades[0]!.priceWad).toBe(27_046_000_000_000_000n);
  });
  it("orders and liquidations parse; null mark stays undefined", () => {
    const d = {
      Trade: [],
      Order: [{ id: "b-1", orderId: "1", isBid: true, tick: "27046", lots: "3", filledLots: "1", remainingLots: "0", flags: 5, status: "Cancelled", placedBlock: "1", updatedBlock: "2" }],
      Liquidation: [{ id: "l", sizeTransferred: "-100", markPriceWad: null, penalty: "1", badDebt: "0", block: "3", timestamp: "4", txHash: "0x" }],
    };
    const h = parseAccountHistory(d, ME);
    expect(h.orders[0]!.flags).toBe(5);
    expect(h.liquidations[0]!.markPriceWad).toBeUndefined();
    expect(h.liquidations[0]!.sizeTransferred).toBe(-100n);
  });
  it("garbled numerics and missing tables throw (no silent zeros)", () => {
    expect(() => parseAccountHistory({ Trade: [{ ...t(ME, "x", true), sizeWad: "1e3" }], Order: [], Liquidation: [] }, ME)).toThrow(/sizeWad/);
    expect(() => parseAccountHistory({ Trade: [], Order: [] }, ME)).toThrow(/Liquidation/);
  });
  it("query filters the perp book by account", () => {
    expect(ACCOUNT_HISTORY_QUERY).toContain('kind: { _eq: "Perp" }');
    expect(ACCOUNT_HISTORY_QUERY).toContain("maker: { _ilike: $a }");
  });
});
