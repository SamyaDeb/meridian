import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PerplBookPayload } from "@/features/chart/datafeed/perpl";
import { PERPL_BOOK_LABEL, PerplLadder } from "./PerplBook";

vi.mock("@/data/hooks", () => ({ useDepth: () => ({}), useTrades: () => ({}) }));
vi.mock("./FundingCard", () => ({ FundingCard: () => null }));

const MON = { id: 10, name: "MON", priceDecimals: 6, sizeDecimals: 0 };
// Recorded from Perpl mainnet's public /v1/market-data/10/book on 7 Oct 2026 (trimmed)
const SNAP: PerplBookPayload = {
  market: MON,
  block: 111245634,
  timeMs: 1791352470000,
  bid: [
    { p: 27222, s: 3673, o: 1 },
    { p: 27218, s: 73379, o: 1 },
  ],
  ask: [
    { p: 27307, s: 3662, o: 1 },
    { p: 27316, s: 2685, o: 1 },
  ],
};

describe("Perpl book tab: labelled, read-only, never Meridian's", () => {
  it("the label names the venue and says it can't be traded here", () => {
    expect(PERPL_BOOK_LABEL).toBe("Perpl MON-PERP · Monad mainnet · read-only, can't be traded here");
  });
  it("renders the levels, spread, block and source, with no button anywhere (nothing loads into the ticket)", () => {
    const h = renderToStaticMarkup(<PerplLadder payload={SNAP} />);
    expect(h).toContain("0.027222");
    expect(h).toContain("0.027307");
    expect(h).toContain("Perpl spread");
    expect(h).toContain("Block #111,245,634");
    expect(h).toContain("via Perpl&#x27;s public API");
    expect(h).not.toContain("<button");
    expect(h).toContain('aria-label="Perpl asks"');
  });
  it("an empty Perpl book says so", () => {
    expect(renderToStaticMarkup(<PerplLadder payload={{ ...SNAP, bid: [], ask: [] }} />)).toContain("Perpl book empty");
  });
});

describe("book card tabs", () => {
  it("are Meridian's own (Perpl is a market in the strip's dropdown, not a tab)", async () => {
    const { bookTabs } = await import("./OrderBookCard");
    expect(bookTabs().map((t) => t.id)).toEqual(["book", "trades", "depth"]);
  });
});
