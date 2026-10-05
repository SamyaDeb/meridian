import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPerplClient, fixtureTransport, matchMarket, parseContext, parseFundingSeries, perplRateToAprWad, readPerplVenue } from "../src/perpl";

// REAL Perpl responses recorded 5 Oct 2026 with `pnpm --filter @pulse/mfi record:perpl <net> MON` (fixtures/recorded/).
const rec = (net: string, n: string) => JSON.parse(readFileSync(new URL(`../fixtures/recorded/${net}/${n}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const noSleep = { sleep: async () => {}, random: () => 0 };

describe.each([
  { net: "testnet", id: 64, priceDecimals: 5 },
  { net: "mainnet", id: 10, priceDecimals: 6 },
])("recorded Perpl $net (MON market $id)", ({ net, id, priceDecimals }) => {
  const ctx = rec(net, "context");
  const funding = rec(net, `funding-${id}`);
  const ticker = rec(net, `ticker-${id}`);

  it("MON resolves by symbol (testnet) or by name with an empty symbol (mainnet); decimals and 43 min interval", () => {
    const m = matchMarket(parseContext(ctx).markets, "MON")!;
    expect(m.id).toBe(id);
    expect(m.config.price_decimals).toBe(priceDecimals);
    expect(m.config.size_decimals).toBe(0);
    expect(m.funding_interval_sec).toBe(2580); // ≈ 43 min (ARCHITECTURE R27), not 1 h
  });

  it("MFI.md §2 (a): rate is micros of notional per interval: ppl = trunc(rate · idx / 10^(6 − funding_sum_scaling_exp)), Δsum = ppl", () => {
    const raw = funding.d as { rate: number; idx: number; ppl: number; sum: number }[];
    const exp = (ctx.markets as { id: number; config: { funding_sum_scaling_exp: number } }[]).find((x) => x.id === id)!.config.funding_sum_scaling_exp;
    expect(raw.length).toBeGreaterThan(20);
    // payment per unit size = rate·1e-6 · idx·10^-pd; ppl stores it ×10^(pd + exp)
    for (const e of raw) expect(e.ppl).toBe(Math.trunc((e.rate * e.idx) / 10 ** (6 - exp)));
    for (let i = 1; i < raw.length; i++) expect(raw[i]!.sum - raw[i - 1]!.sum).toBe(raw[i]!.ppl);
    expect(parseFundingSeries(funding).d).toHaveLength(raw.length); // the validator accepts the real shape
  });

  it("replay: the venue read over the recording = the newest in-force event, mark from the ticker", async () => {
    const events = funding.d as { at: { t: number }; rate: number; feb: number }[];
    const last = events.at(-1)!;
    const now = last.at.t + 1_000;
    const iv = 2_580_000;
    const t = fixtureTransport({
      "/v1/pub/context": { status: 200, body: ctx },
      [`/v1/market-data/${id}/ticker`]: { status: 200, body: ticker },
      [`/v1/market-data/${id}/funding/${now - 2 * iv}-${now + iv}`]: { status: 200, body: funding },
    });
    const c = createPerplClient({ transport: t, ...noSleep });
    const v = await readPerplVenue(c, await c.findMarket("MON"), now);
    expect(v.marketId).toBe(id);
    expect(v.fundingEventBlock).toBe(last.feb);
    expect(v.aprWad).toBe(perplRateToAprWad(last.rate, 2580));
    const mrk = (ticker.d as Record<string, { mrk: number }>)[String(id)]!.mrk;
    expect(v.markWad).toBe(BigInt(mrk) * 10n ** BigInt(18 - priceDecimals));
  });
});

describe("matchMarket", () => {
  const mk = (id: number, symbol: string, name: string) => ({ id, symbol, name, funding_interval_sec: 1, funding_interval_blocks: 1, config: { is_open: true, price_decimals: 0, size_decimals: 0 } });
  it("symbol wins over name; ambiguous ⇒ undefined (never guess)", () => {
    expect(matchMarket([mk(1, "", "MON"), mk(2, "MON", "MON Perp")], "mon")?.id).toBe(2);
    expect(matchMarket([mk(1, "", "MON"), mk(2, "", "MON")], "MON")).toBeUndefined();
    expect(matchMarket([mk(1, "XMON", "MON")], "MON")).toBeUndefined(); // a non-empty other symbol is not a name match
  });
});
