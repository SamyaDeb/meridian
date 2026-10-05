import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, LAYOUT_BOUNDS, clampLayout, parseLayout } from "./layout";

describe("terminal layout", () => {
  it("clamps to bounds and rounds", () => {
    expect(clampLayout({ bookW: 10, posH: 9_999 })).toEqual({ bookW: LAYOUT_BOUNDS.bookW[0], posH: LAYOUT_BOUNDS.posH[1] });
    expect(clampLayout({ bookW: 333.6, posH: 250.2 })).toEqual({ bookW: 334, posH: 250 });
    expect(clampLayout({ bookW: Number.NaN })).toEqual(DEFAULT_LAYOUT);
  });
  it("parses stored JSON, falls back on junk", () => {
    expect(parseLayout(JSON.stringify({ bookW: 400, posH: 200 }))).toEqual({ bookW: 400, posH: 200 });
    expect(parseLayout("x")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ bookW: "wide" }))).toEqual(DEFAULT_LAYOUT);
  });
});
