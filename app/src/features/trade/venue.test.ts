import { describe, expect, it } from "vitest";
import { parseVenue } from "./venue";
import { perplDayStats } from "@/components/market/PerplStrip";

describe("parseVenue", () => {
  it("is Perpl only for ?venue=perpl with the flag on", () => {
    expect(parseVenue("?venue=perpl", true)).toBe("perpl");
    expect(parseVenue("?market=eth&venue=perpl", true)).toBe("perpl");
  });
  it("is Meridian otherwise", () => {
    expect(parseVenue("?venue=perpl", false)).toBe("meridian");
    expect(parseVenue("", true)).toBe("meridian");
    expect(parseVenue("?venue=binance", true)).toBe("meridian");
  });
});

describe("perplDayStats", () => {
  const MON = { id: 10, name: "MON", priceDecimals: 6, sizeDecimals: 0 };
  const H = 3_600_000;
  const now = 100 * H;
  it("takes the last close and the trailing 24h open / high / low (WAD)", () => {
    const d = [
      { t: now - 30 * H, o: 30_000, h: 99_000, l: 1_000, c: 30_000 }, // older than 24 h: ignored
      { t: now - 23 * H, o: 26_000, h: 27_000, l: 25_500, c: 26_500 },
      { t: now - 1 * H, o: 26_500, h: 26_600, l: 24_700, c: 24_800 },
    ];
    const s = perplDayStats({ market: MON, r: 3600, d }, now)!;
    expect(s.last).toBe(24_800n * 10n ** 12n);
    expect(s.open).toBe(26_000n * 10n ** 12n);
    expect(s.high).toBe(27_000n * 10n ** 12n);
    expect(s.low).toBe(24_700n * 10n ** 12n);
  });
  it("is undefined without candles", () => {
    expect(perplDayStats({ market: MON, r: 3600, d: [] }, now)).toBeUndefined();
  });
});
