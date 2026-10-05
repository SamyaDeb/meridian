import { describe, expect, it } from "vitest";
import { launchGuard } from "../src/launch.js";

const base = { chainId: 143, market: "swap", requoteBps: 2n, allowHighBurn: false };

describe("launchGuard: swap MM launch cost on 143 (decision D13)", () => {
  it("refuses the swap MM on 143 below REQUOTE_BPS 1000", () => {
    expect(launchGuard(base)).toMatch(/refusing MARKET=swap on chain 143 with REQUOTE_BPS=2/);
    expect(launchGuard({ ...base, requoteBps: 999n })).not.toBeNull();
  });
  it("allows the launch config (1000) and anything above", () => {
    expect(launchGuard({ ...base, requoteBps: 1000n })).toBeNull();
    expect(launchGuard({ ...base, requoteBps: 5000n })).toBeNull();
  });
  it("ALLOW_HIGH_BURN=1 overrides", () => {
    expect(launchGuard({ ...base, allowHighBurn: true })).toBeNull();
  });
  it("leaves the perp MM and other chains alone", () => {
    expect(launchGuard({ ...base, market: "main" })).toBeNull();
    expect(launchGuard({ ...base, market: "demo" })).toBeNull();
    expect(launchGuard({ ...base, chainId: 10143 })).toBeNull();
    expect(launchGuard({ ...base, chainId: 31337 })).toBeNull();
  });
});
