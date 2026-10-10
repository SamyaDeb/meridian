// Ticket quote on REAL recorded testnet books (packages/core/fixtures/books/testnet-meridian-69059070.json): Meridian
// getDepth + riskParams at block 69,059,070 and the Perpl REST book at the same session; Perpl fee + margins from the
// recorded exchange views (fixtures/perpl/chain/market-10143.json: getTakerFee 345, getMarginFractions 300 / 500).
import rec from "../../../../packages/core/fixtures/books/testnet-meridian-69059070.json";
import { meridianLevels, perplLevels } from "@meridian/core/route";
import { perplFeeWad } from "@meridian/core/perpl";
import { feeText, quoteTicket, summaryText, type VenueInput } from "../../features/trade/ticket/quote";

const WAD = 10n ** 18n;
const m = rec.meridian;
const tick = BigInt(m.tickSize);
const lot = BigInt(m.lotSize);
const mLevels = (side: "bids" | "asks") => meridianLevels(m[side].ticks, m[side].lots.map(BigInt), tick, lot);
const pLevels = (side: "bid" | "ask") => perplLevels(rec.perpl.book[side], 5, 0);

function venues(o: { perplReady?: boolean; perplFree?: bigint; meridianFree?: bigint; wallet?: bigint } = {}): { long: VenueInput[]; short: VenueInput[] } {
  const mer = (levels: ReturnType<typeof mLevels>): VenueInput => ({
    venue: "meridian",
    label: "Meridian",
    levels,
    takerFeeWad: BigInt(m.riskParams.takerFee),
    stepWad: lot,
    priceStepWad: tick,
    priceDp: 6,
    maxLeverage: 5, // 1 / imr 0.2
    ready: true,
    freeCollateralWad: o.meridianFree ?? 0n,
    walletWad: o.wallet ?? 1_000n * WAD,
    liq: { kind: "meridian", mmrWad: BigInt(m.riskParams.mmr), imrWad: BigInt(m.riskParams.imr), collateralWad: o.meridianFree ?? 0n, position: undefined },
  });
  const per = (levels: ReturnType<typeof pLevels>): VenueInput => ({
    venue: "perpl",
    label: "Perpl",
    levels,
    takerFeeWad: perplFeeWad(345),
    stepWad: WAD,
    priceStepWad: 10n ** 13n,
    priceDp: 5,
    maxLeverage: 3, // init 300 hdths
    ready: o.perplReady ?? true,
    freeCollateralWad: o.perplFree ?? 1_000n * WAD,
    walletWad: o.wallet ?? 1_000n * WAD,
    liq: { kind: "perpl", maintHdths: 500n, priceDecimals: 5, sizeDecimals: 0, collateralDecimals: 6 },
  });
  return { long: [mer(mLevels("asks")), per(pLevels("ask"))], short: [mer(mLevels("bids")), per(pLevels("bid"))] };
}

describe("router choice on the recorded books", () => {
  it("long $5 × 2: Perpl's ask 0.02567 beats Meridian's 0.025864 ⇒ Perpl, size floored to 1 MON", () => {
    const q = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "best", venues: venues().long });
    expect(q.status).toBe("ok");
    expect(q.best).toBe("perpl");
    const c = q.chosen!;
    expect(c.venue).toBe("perpl");
    // size = ⌊10 / (0.02567 · 1.01)⌋ = ⌊385.69…⌋ = 385 MON
    expect(c.sizeWad).toBe(385n * WAD);
    // worst price = best ask (the only level needed) + 1 %, rounded UP to the 1e-5 step: 0.02567 · 1.01 = 0.0259267 → 0.02593
    expect(c.limitPriceWad).toBe(2593n * 10n ** 13n);
    expect(c.quote.walk.avgPriceWad).toBe(2567n * 10n ** 13n);
    // margin = notional / leverage ≤ the amount entered
    expect(c.marginWad <= 5n * WAD).toBe(true);
    expect(c.feeWad).toBeGreaterThan(0n);
    expect(c.blockers).toEqual([]);
  });
  it("short $5 × 2: Meridian's bid 0.025848 beats Perpl's 0.02551 ⇒ Meridian, size floored to its 100-MON lot", () => {
    const q = quoteTicket({ side: "short", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "best", venues: venues({ meridianFree: 50n * WAD }).short });
    expect(q.best).toBe("meridian");
    const c = q.chosen!;
    expect(c.sizeWad).toBe(300n * WAD); // ⌊10 / 0.025848⌋ = 386 MON → 300 (lot 100)
    // worst price = the bid used − 1 %, rounded DOWN to the 1e-6 tick: 0.025848 · 0.99 = 0.02558952 → 0.025589
    expect(c.limitPriceWad).toBe(25589n * tick);
  });
  it("$10 × 2 short = 700 MON is deeper than Meridian's 600 MON of bids ⇒ Perpl", () => {
    const q = quoteTicket({ side: "short", amountWad: 10n * WAD, leverage: 2, slippageBps: 100n, pick: "best", venues: venues({ meridianFree: 50n * WAD }).short });
    expect(q.best).toBe("perpl");
    expect(q.lines.find((l) => l.venue === "meridian")!.reason).toBe("Not enough depth on Meridian");
  });
  it("a size the Meridian book can't fill goes to the venue that can (no fake depth)", () => {
    const q = quoteTicket({ side: "long", amountWad: 100n * WAD, leverage: 3, slippageBps: 100n, pick: "best", venues: venues().long });
    expect(q.best).toBe("perpl");
    expect(q.lines.find((l) => l.venue === "meridian")!.reason).toMatch(/depth|leverage/);
  });
});

describe("eligibility, blockers, picks", () => {
  it("leverage above a venue's max makes it ineligible with the reason", () => {
    const q = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 10, slippageBps: 100n, pick: "best", venues: venues().long });
    expect(q.lines.every((l) => !l.eligible)).toBe(true);
    expect(q.lines.find((l) => l.venue === "perpl")!.reason).toBe("Max 3× on Perpl");
    expect(q.status).toBe("no-venue");
  });
  it("forcing a venue quotes that venue even when the other is cheaper", () => {
    const q = quoteTicket({ side: "long", amountWad: 10n * WAD, leverage: 3, slippageBps: 100n, pick: "meridian", venues: venues({ meridianFree: 100n * WAD }).long });
    expect(q.best).toBe("perpl");
    expect(q.chosen!.venue).toBe("meridian");
    expect(q.chosen!.sizeWad).toBe(1100n * WAD); // ⌊30 / 0.0259267⌋ = 1,157 → 1,100 MON, but only 200 MON of asks
    expect(q.chosen!.eligible).toBe(false);
    expect(q.chosen!.reason).toBe("Not enough depth on Meridian");
    expect(q.status).toBe("venue-unavailable");
  });
  it("Perpl not set up ⇒ the onboarding blocker; Perpl short of collateral ⇒ 'move' with the exact shortfall (rounded up)", () => {
    const a = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "perpl", venues: venues({ perplReady: false }).long });
    expect(a.chosen!.blockers.map((b) => b.kind)).toEqual(["onboard"]);
    const b = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "perpl", venues: venues({ perplFree: 1n * WAD }).long });
    const mv = b.chosen!.blockers.find((x) => x.kind === "move");
    expect(mv).toBeDefined();
    const short = b.chosen!.marginWad + b.chosen!.feeWad - 1n * WAD;
    expect(mv!.amountWad >= short && mv!.amountWad < short + 10n ** 12n).toBe(true);
    expect(mv!.amountWad % 10n ** 12n).toBe(0n); // whole AUSD token units, owed ⇒ rounded up
  });
  it("Meridian short of collateral ⇒ an automatic deposit (permit) of the shortfall, or 'fund' when the wallet can't cover it", () => {
    const d = quoteTicket({ side: "short", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "meridian", venues: venues({ meridianFree: 0n }).short });
    const dep = d.chosen!.blockers.find((x) => x.kind === "deposit");
    expect(dep?.amountWad).toBeGreaterThan(0n);
    const f = quoteTicket({ side: "short", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "meridian", venues: venues({ meridianFree: 0n, wallet: 1n * WAD }).short });
    expect(f.chosen!.blockers.map((x) => x.kind)).toContain("fund");
  });
  it("no amount ⇒ empty; amount too small for any step ⇒ too-small; an empty book ⇒ no-liquidity (never fake levels)", () => {
    expect(quoteTicket({ side: "long", amountWad: undefined, leverage: 2, slippageBps: 100n, pick: "best", venues: venues().long }).status).toBe("empty");
    expect(quoteTicket({ side: "long", amountWad: WAD / 100n, leverage: 1, slippageBps: 100n, pick: "best", venues: venues().long }).status).toBe("too-small");
    const empty = venues().long.map((v) => ({ ...v, levels: [] }));
    expect(quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "best", venues: empty }).status).toBe("no-liquidity");
  });
});

describe("liquidation preview + summary", () => {
  it("Perpl long liq uses Perpl's own rule (below the entry); Meridian short liq is above the entry", () => {
    const l = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "perpl", venues: venues().long }).chosen!;
    expect(l.liqWad).toBeDefined();
    expect(l.liqWad! < l.quote.walk.avgPriceWad!).toBe(true);
    const s = quoteTicket({ side: "short", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "meridian", venues: venues({ meridianFree: 0n }).short }).chosen!;
    expect(s.liqWad! > s.quote.walk.avgPriceWad!).toBe(true);
  });
  it("summary: side, size, venue, worst price, fee (cents, rounded up), liq", () => {
    const c = quoteTicket({ side: "long", amountWad: 5n * WAD, leverage: 2, slippageBps: 100n, pick: "best", venues: venues().long }).chosen!;
    const text = summaryText({ side: "long", chosen: c });
    expect(text).toMatch(/^Long 385 MON on Perpl · worst price \$0\.02593 · fee \$0\.0\d · liq \$0\.0\d+$/);
  });
  it("fee text never shows less than owed: 0.0001 → $0.01, 0 → $0.00", () => {
    expect(feeText(10n ** 14n)).toBe("$0.01");
    expect(feeText(0n)).toBe("$0.00");
    expect(feeText(1234n * 10n ** 16n)).toBe("$12.34");
    expect(feeText(12341n * 10n ** 15n)).toBe("$12.35");
  });
});
