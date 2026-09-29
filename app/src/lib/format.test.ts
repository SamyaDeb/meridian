import { describe, it, expect } from "vitest";
import {
  formatFixed,
  formatAusdToken,
  formatAusdWad,
  formatSignedAusdWad,
  formatPriceWad,
  formatAprWad,
  formatSignedAprWad,
  formatLeverageWad,
  formatBaseWad,
  formatDuration,
  parseFixed,
  shortAddress,
} from "./format";
import { WAD } from "./units";

describe("formatFixed", () => {
  it("rounds toward zero and groups thousands", () => {
    expect(formatFixed(1_234_567_899n, 6, 2)).toBe("1,234.56");
    expect(formatFixed(-1_234_567_899n, 6, 2)).toBe("-1,234.56");
    expect(formatFixed(999n, 6, 2)).toBe("0.00");
    expect(formatFixed(-999n, 6, 2)).toBe("0.00"); // no "-0.00"
    expect(formatFixed(5n, 0, 2)).toBe("5.00");
    expect(formatFixed(123n, 2, 0)).toBe("1");
  });
});

describe("AUSD: 6 dp onchain, WAD internally", () => {
  it("token and WAD agree", () => {
    expect(formatAusdToken(1_000_000n)).toBe("1.00");
    expect(formatAusdWad(1_000_000n * 10n ** 12n)).toBe("1.00");
    expect(formatAusdToken(123_456_789_012n)).toBe("123,456.78");
    expect(formatSignedAusdWad(3n * WAD / 2n)).toBe("+1.50");
    expect(formatSignedAusdWad(-WAD / 2n)).toBe("-0.50");
  });
});

describe("prices by tick, APR, leverage, sizes", () => {
  it("MON-PERP price at 1e-6 tick shows 6 dp", () => {
    expect(formatPriceWad(29_123_000_000_000_000n)).toBe("0.029123");
    expect(formatPriceWad(29_123_000_000_000_000n, 10n ** 14n)).toBe("0.0291");
  });
  it("APR WAD → percent", () => {
    expect(formatAprWad(1095n * 10n ** 14n)).toBe("10.95%");
    expect(formatAprWad(1095n * 10n ** 14n, 3)).toBe("10.950%");
    expect(formatSignedAprWad(-5n * 10n ** 16n)).toBe("-5.00%");
    expect(formatSignedAprWad(5n * 10n ** 16n)).toBe("+5.00%");
  });
  it("leverage and base size", () => {
    expect(formatLeverageWad(32n * 10n ** 17n)).toBe("3.2x");
    expect(formatBaseWad(50_000n * WAD, 0)).toBe("50,000");
  });
});

describe("misc", () => {
  it("parseFixed", () => {
    expect(parseFixed("12.5", 6)).toBe(12_500_000n);
    expect(parseFixed("1,000", 6)).toBe(1_000_000_000n);
    expect(parseFixed("0.1234567", 6)).toBe(123_456n); // truncates
    expect(parseFixed(".5", 6)).toBe(500_000n);
    expect(parseFixed("abc", 6)).toBeUndefined();
    expect(parseFixed("", 6)).toBeUndefined();
    expect(parseFixed(".", 6)).toBeUndefined();
  });
  it("duration and address", () => {
    expect(formatDuration(29 * 86_400 + 4 * 3_600 + 5)).toBe("29d 4h");
    expect(formatDuration(3 * 3_600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(-1)).toBe("0s");
    expect(shortAddress("0xa11ce00000000000000000000000000000000001")).toBe("0xa11c…0001");
  });
});
