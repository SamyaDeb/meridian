import { describe, expect, it } from "vitest";
import { geoDecision, isGeoRestricted, parseCountryList, parseMode } from "./geo";

const blocked = parseCountryList("XA, xb ,bad,123,XC");

describe("parseCountryList", () => {
  it("keeps only two-letter codes, upper-cased", () => {
    expect([...blocked].sort()).toEqual(["XA", "XB", "XC"]);
  });
  it("empty or missing ⇒ nothing blocked", () => {
    expect(parseCountryList(undefined).size).toBe(0);
    expect(parseCountryList("").size).toBe(0);
  });
});

describe("parseMode", () => {
  it("defaults to writes", () => {
    expect(parseMode(undefined)).toBe("writes");
    expect(parseMode("nonsense")).toBe("writes");
    expect(parseMode(" ALL ")).toBe("all");
  });
});

describe("geoDecision", () => {
  it("allows when the header is absent (local dev) or the country isn't listed", () => {
    expect(geoDecision({ country: undefined, pathname: "/trade", blocked, mode: "all" })).toBe("allow");
    expect(geoDecision({ country: "", pathname: "/trade", blocked, mode: "all" })).toBe("allow");
    expect(geoDecision({ country: "ZZ", pathname: "/trade", blocked, mode: "all" })).toBe("allow");
  });
  it("writes mode never blocks a page (judges can read everything) but restricts writes", () => {
    for (const p of ["/trade", "/earn", "/fix", "/positions", "/stats", "/terms"]) {
      expect(geoDecision({ country: "xa", pathname: p, blocked, mode: "writes" })).toBe("restrict-writes");
    }
  });
  it("all mode blocks pages but keeps /terms and /blocked open", () => {
    expect(geoDecision({ country: "XB", pathname: "/trade", blocked, mode: "all" })).toBe("block");
    expect(geoDecision({ country: "XB", pathname: "/terms", blocked, mode: "all" })).toBe("restrict-writes");
    expect(geoDecision({ country: "XB", pathname: "/blocked", blocked, mode: "all" })).toBe("restrict-writes");
    expect(geoDecision({ country: "XB", pathname: "/termsX", blocked, mode: "all" })).toBe("block");
  });
  it("empty list ⇒ nobody is restricted", () => {
    expect(geoDecision({ country: "XA", pathname: "/trade", blocked: new Set(), mode: "all" })).toBe("allow");
  });
});

describe("isGeoRestricted", () => {
  it("reads the proxy's cookie exactly", () => {
    expect(isGeoRestricted("a=1; pulse_geo=restricted; b=2")).toBe(true);
    expect(isGeoRestricted("pulse_geo=restrictedX")).toBe(false);
    expect(isGeoRestricted("")).toBe(false);
    expect(isGeoRestricted(undefined)).toBe(false);
  });
});
