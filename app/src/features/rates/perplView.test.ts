import { describe, expect, it } from "vitest";
import hedge from "./fixtures/account-10143-k3-hedge.json";
import main1076 from "./fixtures/account-143-1076.json";
import { bpsPct, formatPerplPrice, monitor, monitorHref, parseAccountWire } from "./perplView";

describe("Perpl monitor view model (recorded accounts)", () => {
  it("K3 hedge on testnet: liq 0.02239 (Perpl price decimals 5, rounded toward the mark), 20 % maintenance, 3x", () => {
    const [p] = monitor(parseAccountWire(hedge.expected));
    expect(p!.risk.side).toBe("Long");
    expect(formatPerplPrice(p!.risk.liqPriceWad, 5, "up")).toBe("0.02239");
    expect(formatPerplPrice(p!.risk.entryWad, 5)).toBe("0.02586");
    expect(p!.risk.depositWad).toBe(22_508_666n * 10n ** 12n);
    expect(p!.shocks.map((s) => s.outcome)).toEqual(["liquidated", "ok", "ok", "ok", "ok", "ok"]);
    expect(p!.perplAprWad).toBe(0n); // rate 0 in force at the recording
    expect(p!.fundingPerDayPerplWad).toBe(0n);
    expect(p!.countdown.nextBlock).toBe(69_150_828n + 8_571n);
  });
  it("mainnet account 1076: liq 0.018084, 28.51 % away, 2.98x, pays funding at +3 per 100k per interval", () => {
    const [p] = monitor(parseAccountWire(main1076.expected), 10n ** 17n);
    expect(formatPerplPrice(p!.risk.liqPriceWad, 6, "up")).toBe("0.018084");
    expect(p!.risk.liqDistanceBps).toBe(2851n);
    expect(bpsPct(p!.risk.liqDistanceBps)).toBe("28.51%");
    expect(p!.perplAprWad).toBe(366_697_674_418_604_651n); // 3 · 1e13 · YEAR / 2580
    expect(p!.fundingPerDayPerplWad > 0n).toBe(true); // a long pays at a positive rate
    expect(p!.fundingPerDayMfiWad).toBeDefined();
  });
  it("rejects a malformed payload", () => {
    expect(() => parseAccountWire({ ...hedge.expected, chainId: 1 })).toThrow();
    expect(() => parseAccountWire({ ...hedge.expected, positions: [{ ...hedge.expected.positions[0], lotLNS: 1 }] })).toThrow();
  });
  it("formatting helpers", () => {
    expect(formatPerplPrice(1n, 6, "up")).toBe("0.000001");
    expect(formatPerplPrice(1n, 6, "down")).toBe("0.000000");
    expect(bpsPct(-1500n, 0)).toBe("−15%");
    expect(monitorHref("0xab", 143)).toBe("/rates?perpl=0xab&chain=143#perpl-monitor");
  });
});
