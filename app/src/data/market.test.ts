import { describe, expect, it } from "vitest";
import { mockMarkets } from "@/config/markets";
import { initialMarketKey } from "./market";

const ms = mockMarkets({ clearingHouse: "0x0000000000000000000000000000000000000001", orderBook: "0x0000000000000000000000000000000000000002" });

describe("initialMarketKey", () => {
  it("URL first, then the stored choice, else the primary market", () => {
    expect(initialMarketKey(ms, "eth", "main")).toBe("eth");
    expect(initialMarketKey(ms, null, "eth")).toBe("eth");
    expect(initialMarketKey(ms, "doge", "eth")).toBe("eth");
    expect(initialMarketKey(ms, null, "doge")).toBe("main");
    expect(initialMarketKey(ms, null, null)).toBe("main");
    expect(initialMarketKey([], null, null)).toBe("main");
  });
});
