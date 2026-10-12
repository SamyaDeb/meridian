import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex, relativeLuminance, rootTokens } from "./contrast";

const css = readFileSync(fileURLToPath(new URL("../app/(app)/globals.css", import.meta.url)), "utf8");
const tokens = rootTokens(css);
const t = (k: string): string => {
  const v = tokens[k];
  if (v === undefined) throw new Error(`token --${k} missing from globals.css :root`);
  return v;
};

describe("contrast math", () => {
  it("black on white is 21:1, same colour is 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#836ef9", "#836ef9")).toBe(1);
  });
  it("matches the WCAG reference value for #777777 on white (4.48)", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
  it("luminance is monotone in grey level and parseHex rejects non-hex", () => {
    expect(relativeLuminance("#101010")).toBeLessThan(relativeLuminance("#202020"));
    expect(() => parseHex("violet")).toThrow();
    expect(() => parseHex("#fff")).toThrow();
  });
});

// AA: 4.5 for text, 3 for large text / UI components (WCAG 1.4.3, 1.4.11).
const BACKGROUNDS = ["bg", "card", "card-2", "brand-tint"] as const;
const TEXT = ["text", "muted", "brand", "brand-soft", "long", "short", "warn"] as const;
const FILLED = ["brand", "brand-hover", "long", "short", "warn"] as const;

describe("theme tokens (globals.css) meet WCAG AA", () => {
  it("defines every token the checks need as plain hex", () => {
    for (const k of [...BACKGROUNDS, ...TEXT, ...FILLED, "on-brand", "border"]) expect(tokens[k], k).toMatch(/^#[0-9a-f]{6}$/i);
  });
  for (const bg of BACKGROUNDS)
    for (const fg of TEXT)
      it(`${fg} text on ${bg} ≥ 4.5`, () => {
        expect(contrastRatio(t(fg), t(bg))).toBeGreaterThanOrEqual(4.5);
      });
  for (const fill of FILLED)
    it(`on-brand text on filled ${fill} ≥ 4.5`, () => {
      expect(contrastRatio(t("on-brand"), t(fill))).toBeGreaterThanOrEqual(4.5);
    });
  it("focus ring (brand) against every background ≥ 3", () => {
    for (const bg of BACKGROUNDS) expect(contrastRatio(t("brand"), t(bg))).toBeGreaterThanOrEqual(3);
  });
  it("direction colours are not the brand colour (violet is never a direction cue)", () => {
    expect(t("long")).not.toBe(t("brand"));
    expect(t("short")).not.toBe(t("brand"));
  });
});
