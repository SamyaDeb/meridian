import { amountWadOf, decimalSeparator, displayAmount, pressKey, presetText } from "../../features/trade/ticket/amountText";

const WAD = 10n ** 18n;

describe("numpad keys", () => {
  const type = (keys: string[]) => keys.reduce((t, k) => pressKey(t, k as never), "");
  it("builds a plain decimal, at most 2 decimals (cents), no leading zeros", () => {
    expect(type(["1", "2", ".", "5"])).toBe("12.5");
    expect(type(["0", "0", "7"])).toBe("7");
    expect(type([".", "5"])).toBe("0.5");
    expect(type(["1", ".", "2", "3", "4"])).toBe("1.23");
    expect(type(["1", ".", "."])).toBe("1.");
    expect(type(["0", ".", "0", "5"])).toBe("0.05");
  });
  it("backspace removes one character; empty stays empty", () => {
    expect(pressKey("12.5", "back")).toBe("12.");
    expect(pressKey("1", "back")).toBe("");
    expect(pressKey("", "back")).toBe("");
  });
  it("caps the whole part (no 10-digit fat-finger amounts)", () => {
    expect(type(["9", "9", "9", "9", "9", "9", "9", "9", "9"])).toBe("99999999");
  });
});

describe("locale", () => {
  it("decimal separator from Intl, '.' as the fallback", () => {
    expect(decimalSeparator("en-US")).toBe(".");
    expect(decimalSeparator("de-DE")).toBe(",");
    expect(decimalSeparator("not a locale")).toBe(".");
  });
  it("display swaps in the locale separator and groups the whole part; canonical text stays '.'", () => {
    expect(displayAmount("1234.5", ",")).toBe("1.234,5");
    expect(displayAmount("1234.5", ".")).toBe("1,234.5");
    expect(displayAmount("", ".")).toBe("0");
  });
});

describe("amounts", () => {
  it("text → AUSD WAD, exact; invalid or zero ⇒ undefined", () => {
    expect(amountWadOf("12.5")).toBe(125n * WAD / 10n);
    expect(amountWadOf("0.05")).toBe(5n * WAD / 100n);
    expect(amountWadOf("")).toBeUndefined();
    expect(amountWadOf("0")).toBeUndefined();
    expect(amountWadOf("0.")).toBeUndefined();
  });
  it("presets are pct of available, rounded DOWN to the cent (never more than you have)", () => {
    const avail = 1234_567_891n * 10n ** 9n; // 1.234567891 AUSD
    expect(presetText(avail, 100)).toBe("1.23");
    expect(presetText(avail, 50)).toBe("0.61");
    expect(presetText(avail, 25)).toBe("0.3");
    expect(presetText(0n, 100)).toBe("");
    expect(presetText(undefined, 100)).toBe("");
    expect(amountWadOf(presetText(avail, 100))! <= avail).toBe(true);
  });
});
