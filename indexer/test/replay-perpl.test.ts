// Perpl on real chain data (K2.2/K2.3 evidence): every event of the recorded accounts, replayed through the handlers,
// must end in the state the exchange itself reports at the same block (getPosition, recorded by
// scripts/verify-perpl-positions.mjs). Fixtures: testnet MON (64) and BTC (16, with liquidations), mainnet MON (10).
// The recorder also checked lots continuity on every position event of each window (continuityBreaks = 0).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { CHAIN } from "./helpers.js";
import { TEST_PERPL_EXCHANGE } from "../scripts/gen-config.mjs";
import { perplAprWad } from "../src/lib/math.js";

type Answer = { positionType: number; lotLNS: bigint; depositCNS: bigint; pricePNS: bigint };
type Fixture = {
  chainId: number;
  perpId: string;
  atBlock: number;
  counts: Record<string, number>;
  continuityBreaks: number;
  contractMismatches: unknown[];
  answers: Record<string, Answer>;
  items: Array<{ event: string; srcAddress: string; params: Record<string, unknown> }>;
};
const load = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"), (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Fixture;

const FIXTURES = ["./fixtures/perpl-10143/replay-64.json", "./fixtures/perpl-10143/replay-16.json", "./fixtures/perpl-143/replay-10.json"];

describe.each(FIXTURES)("%s", (path) => {
  const fx = load(path);
  // the test config indexes the exchange at TEST_PERPL_EXCHANGE on 31337 (metadata = the testnet snapshot)
  const items = fx.items.map((i) => ({ ...i, srcAddress: TEST_PERPL_EXCHANGE }));
  const run = async () => {
    const indexer = createTestIndexer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await indexer.process({ chains: { [CHAIN]: { simulate: items as any } } });
    return indexer;
  };

  it("recording: lots continuity held on every position event; the recorder's own model matched getPosition", () => {
    expect(fx.continuityBreaks).toBe(0);
    expect(fx.contractMismatches).toEqual([]);
    expect(Object.keys(fx.answers).length).toBeGreaterThan(0);
  });

  it("PerplPosition = the exchange's getPosition at the recording block (lots, side, collateral, entry)", async () => {
    const indexer = await run();
    for (const [acc, want] of Object.entries(fx.answers)) {
      const p = await indexer.PerplPosition.getOrThrow(`${fx.perpId}-${acc}`);
      expect(p.lots, `${acc} lots`).toBe(want.lotLNS);
      expect(p.open, `${acc} open`).toBe(want.lotLNS > 0n);
      if (want.lotLNS > 0n) {
        expect(p.side, `${acc} side`).toBe(want.positionType === 0 ? "Long" : "Short");
        expect(p.depositCNS, `${acc} deposit`).toBe(want.depositCNS);
        expect(p.entryPriceExact, `${acc} exact`).toBe(true); // every replayed account opened inside the window
        expect(p.entryPricePNS, `${acc} entry`).toBe(want.pricePNS);
      }
    }
  });

  it("funding: one row per interval; APR from the seeded interval; liquidations all recorded", async () => {
    const indexer = await run();
    const fund = items.filter((i) => i.event === "FundingEventCompleted");
    const rows = await indexer.PerplFunding.getAll();
    expect(rows.length).toBe(new Set(fund.map((i) => String(i.params.fundingEventBlock))).size);
    const known = (await indexer.PerplMarket.getOrThrow(fx.perpId)).known;
    for (const r of rows) expect(r.aprWad).toBe(known ? perplAprWad(r.ratePct100k, 2580) : undefined);
    const liq = items.filter((i) => i.event === "PositionLiquidated").length;
    expect((await indexer.PerplLiquidation.getAll()).length).toBe(liq);
    expect(liq).toBe(fx.counts.PositionLiquidated);
  });
});
