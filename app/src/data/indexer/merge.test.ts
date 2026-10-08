// K2.4: indexer values replace the browser's / contract fallbacks only where the indexer has them.
import { describe, expect, it } from "vitest";
import { withFundingWindow } from "../hooks";
import { crossVenuePoints } from "@/features/rates/CrossVenueCard";
import type { Market } from "../types";

const m = { realizedApr1hWad: 1n, realizedApr8hWad: 8n, realizedApr24hWad: 24n } as Market;

describe("withFundingWindow", () => {
  it("indexer windows win; a null indexer window keeps the contract value; 7 d appears only from the indexer", () => {
    const r = withFundingWindow(m, { block: 1n, rateAprWad: 0n, apr1hWad: 11n, apr7dWad: 77n });
    expect([r.realizedApr1hWad, r.realizedApr8hWad, r.realizedApr24hWad, r.realizedApr7dWad]).toEqual([11n, 8n, 24n, 77n]);
    expect(withFundingWindow(m, { block: 1n, rateAprWad: 0n })).not.toHaveProperty("realizedApr7dWad");
  });
});

describe("crossVenuePoints", () => {
  it("hours → ms points, no MFI line, gaps stay null", () => {
    expect(crossVenuePoints([{ hour: 3_600, meridianAprWad: 5n }])).toEqual([{ t: 3_600_000, mfi: null, meridian: 5n, perpl: null, stale: false }]);
  });
});
