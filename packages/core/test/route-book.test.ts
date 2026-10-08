import { describe, expect, it } from "vitest";
import { meridianLevels, perplLevels, quoteVenue, route, walkBook, type BookLevel, type VenueBook } from "../src/route";
import { WAD } from "../src/util/fixed";
import { fixtureJson, fixtureLines, rng } from "./helpers";

const T = 10n ** 12n; // tick 1e-6 (test input)
const LOT = 100n * WAD; // Meridian lot 100 MON (test input)
const L = (priceTicks: bigint, sizeMon: bigint): BookLevel => ({ priceWad: priceTicks * T, sizeWad: sizeMon * WAD });
const asks = [L(25_864n, 200n), L(25_900n, 300n), L(26_000n, 1_000n)];
const bids = [L(25_848n, 500n), L(25_784n, 100n)];

describe("walkBook", () => {
  it("buyer: average and notional round UP; seller: DOWN; exact when it divides", () => {
    const b = walkBook(asks, 300n * WAD, "buy");
    // 200·0.025864 + 100·0.0259 = 5.1728 + 2.59 = 7.7628; avg = 0.025876
    expect(b.notionalWad).toBe(7_762_800_000_000_000_000n);
    expect(b.avgPriceWad).toBe(25_876_000_000_000_000n);
    expect(b.levelsUsed).toBe(2);
    expect(b.worstPriceWad).toBe(25_900n * T);
    const odd = [{ priceWad: 3n, sizeWad: 1n }, { priceWad: 4n, sizeWad: 2n }];
    const buy = walkBook(odd, 3n, "buy"); // Σ = 3 + 8 = 11 over 3 ⇒ 3.67
    expect(buy.avgPriceWad).toBe(4n); // ceil
    const sell = walkBook([{ priceWad: 4n, sizeWad: 2n }, { priceWad: 3n, sizeWad: 1n }], 3n, "sell");
    expect(sell.avgPriceWad).toBe(3n); // floor
  });
  it("never over-fills; residual when the book is short; size floored to the step; limit stops the walk", () => {
    const w = walkBook(asks, 10_000n * WAD, "buy");
    expect(w.filledWad).toBe(1_500n * WAD);
    expect(w.residualWad).toBe(8_500n * WAD);
    const s = walkBook(asks, 250n * WAD, "buy", { stepWad: LOT });
    expect(s.targetWad).toBe(200n * WAD);
    expect(s.filledWad).toBe(200n * WAD);
    expect(s.residualWad).toBe(50n * WAD);
    const lim = walkBook(asks, 1_000n * WAD, "buy", { limitPriceWad: 25_900n * T });
    expect(lim.filledWad).toBe(500n * WAD);
    expect(walkBook([], 1n, "sell")).toMatchObject({ filledWad: 0n, avgPriceWad: undefined, residualWad: 1n });
  });
  it("rejects levels that aren't best first", () => {
    expect(() => walkBook([...asks].reverse(), WAD, "buy")).toThrow(/best first/);
    expect(() => walkBook([...bids].reverse(), WAD, "sell")).toThrow(/best first/);
  });
  it("property (seeded): filled ≤ requested; buyer avg·filled ≥ exact Σ; seller avg·filled ≤ exact Σ; avg within [best, worst]", () => {
    const r = rng(42);
    for (let n = 0; n < 500; n++) {
      const side = r.next() < 0.5 ? "buy" : "sell";
      let px = BigInt(r.int(1, 10 ** 9));
      const lv: BookLevel[] = [];
      for (let i = 0, k = r.int(0, 8); i < k; i++) {
        lv.push({ priceWad: px, sizeWad: r.big(1n, 10n ** 22n) });
        px = side === "buy" ? px + BigInt(r.int(0, 10 ** 6)) : px - BigInt(r.int(0, 10 ** 6)) > 0n ? px - BigInt(r.int(0, 10 ** 6)) : 1n;
      }
      if (side === "sell") lv.sort((a, b) => (a.priceWad > b.priceWad ? -1 : a.priceWad < b.priceWad ? 1 : 0));
      const step = [1n, 10n ** 18n, 10n ** 20n][r.int(0, 2)]!;
      const size = r.big(0n, 10n ** 23n);
      const w = walkBook(lv, size, side, { stepWad: step });
      expect(w.filledWad <= size).toBe(true);
      expect(w.filledWad % step).toBe(0n);
      const exact = w.fills.reduce((s, f) => s + f.sizeWad * f.priceWad, 0n);
      if (w.avgPriceWad !== undefined) {
        if (side === "buy") expect(w.avgPriceWad * w.filledWad >= exact && w.notionalWad * WAD >= exact).toBe(true);
        else expect(w.avgPriceWad * w.filledWad <= exact && w.notionalWad * WAD <= exact).toBe(true);
        const best = w.fills[0]!.priceWad;
        const worst = w.worstPriceWad!;
        const [lo, hi] = best < worst ? [best, worst] : [worst, best];
        expect(w.avgPriceWad >= lo && w.avgPriceWad <= hi).toBe(true);
      }
    }
  });
});

const books = (m: Partial<VenueBook>, p: Partial<VenueBook>, side: "buy" | "sell" = "buy"): VenueBook[] => [
  { venue: "meridian", levels: side === "buy" ? asks : bids, takerFeeWad: 5n * 10n ** 14n, stepWad: LOT, ...m },
  { venue: "perpl", levels: side === "buy" ? [L(25_870n, 10_000n)] : [L(25_850n, 10_000n)], takerFeeWad: 345n * 10n ** 12n, stepWad: WAD, ...p },
];

describe("router v1", () => {
  it("fee included: Meridian's better price can lose to Perpl's lower fee", () => {
    // 200 MON buy: Meridian 0.025864 · 1.0005 = 0.025876932 vs Perpl 0.02587 · 1.000345 = 0.025878925… ⇒ Meridian
    expect(route("buy", 200n * WAD, books({}, {})).best).toBe("meridian");
    // Perpl at 0.025860 · 1.000345 = 0.0258689… < Meridian ⇒ Perpl
    expect(route("buy", 200n * WAD, books({}, { levels: [L(25_860n, 10_000n)] })).best).toBe("perpl");
  });
  it("effective price rounds against the user; fee owed rounds up", () => {
    const q = quoteVenue({ venue: "perpl", levels: [{ priceWad: 3n, sizeWad: 1n }], takerFeeWad: 1n, stepWad: 1n }, "buy", 1n);
    expect(q.feeWad).toBe(1n); // 3·1/1e18 → ceil 1
    expect(q.effectivePriceWad).toBe(4n); // 3·(1e18+1)/1e18 → ceil
    const s = quoteVenue({ venue: "perpl", levels: [{ priceWad: 3n, sizeWad: 1n }], takerFeeWad: 1n, stepWad: 1n }, "sell", 1n);
    expect(s.effectivePriceWad).toBe(2n); // floor
    expect(s.totalWad).toBe(0n); // seller notional floors to 0: a dust sell never pays out more than it is worth
  });
  it("tie → Meridian; residual (depth or size step) → ineligible; unavailable → never picked", () => {
    const same = [L(25_864n, 1_000n)];
    expect(route("buy", 100n * WAD, books({ levels: same, takerFeeWad: 0n }, { levels: same, takerFeeWad: 0n })).best).toBe("meridian");
    const deep = route("buy", 2_000n * WAD, books({}, {}));
    expect(deep.quotes[0]).toMatchObject({ venue: "meridian", eligible: false, reason: "insufficient-depth" });
    expect(deep.best).toBe("perpl");
    expect(route("buy", 150n * WAD, books({}, {})).quotes[0]).toMatchObject({ eligible: false, reason: "size-step" });
    expect(route("buy", 200n * WAD, books({}, { available: false, levels: [L(1n, 10_000n)] })).best).toBe("meridian");
    expect(route("buy", 200n * WAD, books({ levels: [] }, { available: false })).best).toBeUndefined();
  });
  it("property (seeded): the router never picks a venue whose effective price is worse than an eligible other", () => {
    const r = rng(7);
    for (let n = 0; n < 400; n++) {
      const side = r.next() < 0.5 ? "buy" : "sell";
      const mk = (venue: "meridian" | "perpl"): VenueBook => {
        const lv: BookLevel[] = [];
        let px = BigInt(r.int(20_000, 30_000)) * T;
        for (let i = 0, k = r.int(0, 5); i < k; i++) {
          lv.push({ priceWad: px, sizeWad: BigInt(r.int(1, 20)) * LOT });
          px = side === "buy" ? px + BigInt(r.int(0, 50)) * T : px - BigInt(r.int(0, 50)) * T;
        }
        return { venue, levels: lv, takerFeeWad: BigInt(r.int(0, 1_000)) * 10n ** 12n, stepWad: venue === "meridian" ? LOT : WAD, available: r.next() > 0.1 };
      };
      const res = route(side, BigInt(r.int(1, 30)) * LOT, [mk("meridian"), mk("perpl")]);
      if (!res.best) {
        expect(res.quotes.every((q) => !q.eligible)).toBe(true);
        continue;
      }
      const chosen = res.quotes.find((q) => q.venue === res.best)!;
      expect(chosen.eligible).toBe(true);
      for (const q of res.quotes) if (q.eligible && q !== chosen) expect(side === "buy" ? chosen.effectivePriceWad! <= q.effectivePriceWad! : chosen.effectivePriceWad! >= q.effectivePriceWad!).toBe(true);
    }
  });
});

type Rec = {
  meridian: { tickSize: string; lotSize: string; bids: { ticks: number[]; lots: string[] }; asks: { ticks: number[]; lots: string[] }; riskParams: { takerFee: string }; markPrice: string; block: string };
  perpl: { market: { priceDecimals: number; sizeDecimals: number }; book: { mt: number; sn: number; bid: { p: number; s: number; o: number }[]; ask: { p: number; s: number; o: number }[] } };
};

describe("recorded-fixture quote: real testnet books", () => {
  const rec = fixtureJson<Rec>("books/testnet-meridian-69059070.json");
  const tick = BigInt(rec.meridian.tickSize);
  const lot = BigInt(rec.meridian.lotSize);
  const mBids = meridianLevels(rec.meridian.bids.ticks, rec.meridian.bids.lots.map(BigInt), tick, lot);
  const mAsks = meridianLevels(rec.meridian.asks.ticks, rec.meridian.asks.lots.map(BigInt), tick, lot);
  const { priceDecimals: pd, sizeDecimals: sd } = rec.perpl.market;
  const pBids = perplLevels(rec.perpl.book.bid, pd, sd);
  const pAsks = perplLevels(rec.perpl.book.ask, pd, sd);
  // Perpl taker 345 micros (recorded market-config, fixtures/perpl/testnet/ws/market-config.jsonl); Meridian riskParams.takerFee
  const pFee = 345n * 10n ** 12n;
  const mFee = BigInt(rec.meridian.riskParams.takerFee);
  const venues = (side: "buy" | "sell"): VenueBook[] => [
    { venue: "meridian", levels: side === "buy" ? mAsks : mBids, takerFeeWad: mFee, stepWad: lot },
    { venue: "perpl", levels: side === "buy" ? pAsks : pBids, takerFeeWad: pFee, stepWad: 10n ** BigInt(18 - sd) },
  ];
  it("normalised: Meridian lot 100 MON, tick 1e-6; Perpl 5 price decimals, size 1 MON", () => {
    expect(lot).toBe(100n * WAD);
    expect(tick).toBe(10n ** 12n);
    expect(mAsks).toEqual([{ priceWad: 25_864n * 10n ** 12n, sizeWad: 200n * WAD }]);
    expect(mBids[0]).toEqual({ priceWad: 25_848n * 10n ** 12n, sizeWad: 500n * WAD });
    expect(pAsks[0]).toEqual({ priceWad: 2567n * 10n ** 13n, sizeWad: 4_616_926n * WAD });
  });
  it("buy 200 MON → Perpl: 0.02567 · 1.000345 beats Meridian 0.025864 · 1.0005", () => {
    const r = route("buy", 200n * WAD, venues("buy"));
    const [m, p] = r.quotes;
    expect(m!.effectivePriceWad).toBe(25_876_932_000_000_000n); // 0.025864 · 1.0005
    expect(p!.effectivePriceWad).toBe(25_678_856_150_000_000n); // 0.02567 · 1.000345
    expect(r.best).toBe("perpl");
  });
  it("sell 500 MON → Meridian bid 0.025848 · 0.9995 beats Perpl 0.02551 · 0.999655; 700 MON exhausts Meridian ⇒ Perpl", () => {
    const r = route("sell", 500n * WAD, venues("sell"));
    expect(r.quotes[0]!.effectivePriceWad).toBe(25_835_076_000_000_000n);
    expect(r.quotes[1]!.effectivePriceWad).toBe(25_501_199_050_000_000n);
    expect(r.best).toBe("meridian");
    const big = route("sell", 700n * WAD, venues("sell"));
    expect(big.quotes[0]).toMatchObject({ eligible: false, reason: "insufficient-depth" });
    expect(big.best).toBe("perpl");
  });
  it("the empty Meridian book recorded today ⇒ Perpl only, Meridian 'empty'", () => {
    const today = fixtureJson<Rec>("books/testnet-2026-10-08T1029.json");
    expect(today.meridian.bids.ticks).toEqual([]);
    const r = route("buy", 100n * WAD, [{ venue: "meridian", levels: [], takerFeeWad: mFee, stepWad: lot }, { venue: "perpl", levels: perplLevels(today.perpl.book.ask, pd, sd), takerFeeWad: pFee, stepWad: WAD }]);
    expect(r.quotes[0]).toMatchObject({ eligible: false, reason: "empty" });
    expect(r.best).toBe("perpl");
  });
  it("the 7 Oct order-book@64 WS snapshot normalises the same way as the REST book", () => {
    const snap = fixtureLines("perpl/testnet/ws/order-book.jsonl")[0]!.frame as { bid: { p: number; s: number; o: number }[] };
    expect(perplLevels(snap.bid, 5, 0)[0]).toEqual({ priceWad: 2574n * 10n ** 13n, sizeWad: 4_298_218n * WAD });
  });
});
