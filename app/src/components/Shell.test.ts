import { describe, expect, it } from "vitest";
import { isTerminalRoute, isWideRoute } from "./Shell";

describe("isWideRoute", () => {
  it("matches the route and its children only", () => {
    expect(isWideRoute("/design")).toBe(true);
    expect(isWideRoute("/design/x")).toBe(true);
    expect(isWideRoute("/designer")).toBe(false);
    expect(isWideRoute("/terms")).toBe(false); // document pages keep the reading column
    for (const r of ["/trade", "/earn", "/fix", "/stats", "/positions"]) expect(isWideRoute(r)).toBe(true);
    expect(isWideRoute("")).toBe(false);
    expect(isWideRoute("/trade")).toBe(true);
  });
  it("terminal routes are exact", () => {
    expect(isTerminalRoute("/trade")).toBe(true);
    expect(isTerminalRoute("/trade/x")).toBe(false);
    expect(isTerminalRoute("/earn")).toBe(false);
  });
});
