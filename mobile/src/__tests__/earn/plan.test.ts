// Earn quote on recorded testnet books: the hero is the pair's net APR (core planBasis), the amount sizes both legs to an
// EQUAL MON size on both steps, limits are snapped against the user, collateral needs round up, blockers name the fix;
// the close plan caps the size by what each venue really holds.
import { planBasis } from "@meridian/core/route";
import { startBasis } from "@meridian/core/exec";
import { EARN_HORIZON_DAYS, earnAvailableWad, planEarnClose, quoteEarn } from "../../features/earn/plan";
import { LOT, meridianIn, pct, perplIn, TICK, WAD } from "./earnFixtures";

const amount = (usd: number) => BigInt(usd) * WAD;

describe("quoteEarn", () => {
  it("loading until both venues have books, fees and steps", () => {
    expect(quoteEarn({ amountWad: amount(10), meridian: meridianIn({ bids: undefined }), perpl: perplIn() }).status).toBe("loading");
    expect(quoteEarn({ amountWad: amount(10), meridian: meridianIn(), perpl: perplIn({ takerFeeWad: undefined }) }).status).toBe("loading");
  });

  it("no amount: the hero is the pair's net APR at any size (core planBasis, 30 d fee drag)", () => {
    const q = quoteEarn({ amountWad: undefined, meridian: meridianIn(), perpl: perplIn() });
    const ref = planBasis({ meridian: { aprWad: pct(30), takerFeeWad: 5n * 10n ** 14n, stepWad: LOT }, perpl: { aprWad: pct(-15), takerFeeWad: 345n * 10n ** 12n, stepWad: WAD }, sizeWad: 0n, markWad: WAD, horizonDays: EARN_HORIZON_DAYS });
    expect(q.status).toBe("empty");
    expect(q.grossAprWad).toBe(pct(45));
    expect(q.aprOnAusdWad).toBe(ref.netAprWad);
    expect(q.shortVenue).toBe("meridian"); // Meridian longs pay more ⇒ short Meridian, long Perpl
  });

  it("no edge when the gap doesn't cover the fees", () => {
    const q = quoteEarn({ amountWad: amount(10), meridian: meridianIn({ aprWad: pct(10.5) }), perpl: perplIn({ aprWad: pct(10) }) });
    expect(q.status).toBe("no-edge");
    expect(q.exec).toBeUndefined();
    expect(quoteEarn({ amountWad: undefined, meridian: meridianIn({ aprWad: pct(1) }), perpl: perplIn({ aprWad: pct(1) }) }).status).toBe("no-edge");
  });

  it("$10: equal size on both venues' steps, Perpl long first, limits against the user, needs rounded up", () => {
    const q = quoteEarn({ amountWad: amount(10), meridian: meridianIn(), perpl: perplIn() });
    expect(q.status).toBe("ok");
    // A/2 per venue at 2× ⇒ ≈ $10 notional per leg ≈ 383 MON at ~0.0261 ⇒ floored to the 100-MON Meridian lot
    expect(q.sizeWad).toBe(300n * WAD);
    expect(q.sizeWad % LOT).toBe(0n);
    const { perpl, meridian } = q.legs!;
    expect(perpl.side).toBe("buy");
    expect(meridian.side).toBe("sell");
    // buy limit ≥ the worst ask it walks (rounded up to the price step); sell limit ≤ the worst bid (rounded down)
    expect(perpl.limitPriceWad).toBeGreaterThanOrEqual(perpl.quote.walk.worstPriceWad!);
    expect(perpl.limitPriceWad % 10n ** 13n).toBe(0n);
    expect(meridian.limitPriceWad).toBeLessThanOrEqual(meridian.quote.walk.worstPriceWad!);
    expect(meridian.limitPriceWad % TICK).toBe(0n);
    // margin = notional / 2 (rounds up), Meridian at least the initial margin; need = margin + fee
    expect(perpl.marginWad * 2n).toBeGreaterThanOrEqual(perpl.quote.walk.notionalWad);
    expect(meridian.needWad).toBe(meridian.marginWad + meridian.feeWad);
    // nothing on the venues yet ⇒ deposits of whole AUSD token units, ≥ the need
    expect(perpl.depositWad % 10n ** 12n).toBe(0n);
    expect(perpl.depositWad).toBeGreaterThanOrEqual(perpl.needWad);
    // margin + fee per venue fits the half of the amount
    expect(perpl.needWad).toBeLessThanOrEqual(amount(5));
    expect(meridian.needWad).toBeLessThanOrEqual(amount(5));
    expect(q.exec).toMatchObject({ perplSide: "buy", sizeWad: 300n * WAD, meridianLotWad: LOT, perplStepWad: WAD, perplCollateralWad: perpl.needWad, meridianCollateralWad: meridian.needWad });
    // core accepts it as is
    expect(() => startBasis("e1", q.exec!)).not.toThrow();
    // ≈ / day and the APR on AUSD are net of fees + slippage and round down
    expect(q.perDayWad! > 0n).toBe(true);
    expect(q.aprOnAusdWad! < q.grossAprWad!).toBe(true);
  });

  it("flips the legs when Perpl's longs pay more; a book that can't take the size ⇒ no-liquidity (nothing executable)", () => {
    const q = quoteEarn({ amountWad: amount(10), meridian: meridianIn({ aprWad: pct(-25) }), perpl: perplIn({ aprWad: pct(20) }) });
    expect(q.legs!.perpl.side).toBe("sell");
    expect(q.legs!.meridian.side).toBe("buy");
    // Meridian's recorded asks hold 100 MON; 300 MON can't fill there
    expect(q.status).toBe("no-liquidity");
    expect(q.exec).toBeUndefined();
    // 100 MON fits
    expect(quoteEarn({ amountWad: amount(4), meridian: meridianIn({ aprWad: pct(-25) }), perpl: perplIn({ aprWad: pct(20) }) }).status).toBe("ok");
  });

  it("too small for one common lot", () => {
    expect(quoteEarn({ amountWad: amount(2), meridian: meridianIn(), perpl: perplIn() }).status).toBe("too-small");
  });

  it("blockers: Perpl not set up; a wallet short for a venue (no exec plan until fixed)", () => {
    const a = quoteEarn({ amountWad: amount(10), meridian: meridianIn(), perpl: perplIn({ ready: false }) });
    expect(a.blockers).toEqual([{ kind: "onboard" }]);
    expect(a.exec).toBeUndefined();
    const b = quoteEarn({ amountWad: amount(10), meridian: meridianIn({ walletWad: 1n * WAD }), perpl: perplIn() });
    expect(b.blockers).toEqual([{ kind: "fund", venue: "meridian", shortWad: b.legs!.meridian.depositWad - WAD }]);
    // free collateral already on the venues ⇒ no deposit, no wallet needed
    const c = quoteEarn({ amountWad: amount(10), meridian: meridianIn({ walletWad: 0n, freeWad: amount(6) }), perpl: perplIn({ walletWad: 0n, freeWad: amount(6) }) });
    expect(c.blockers).toEqual([]);
    expect(c.legs!.meridian.depositWad).toBe(0n);
    expect(c.exec).toBeDefined();
  });

  it("presets: 2 × the binding venue (free + its wallet token)", () => {
    expect(earnAvailableWad({ freeWad: amount(3), walletWad: amount(4) }, { freeWad: 0n, walletWad: amount(5) })).toBe(amount(10));
    expect(earnAvailableWad({ freeWad: undefined, walletWad: undefined }, { freeWad: 0n, walletWad: amount(5) })).toBeUndefined();
  });
});

describe("planEarnClose", () => {
  const books = { meridian: meridianIn(), perplBook: perplIn() };
  it("closes the pair: Meridian buys back its short first, Perpl sells (side it hits: bids)", () => {
    // pair opened long Perpl / short Meridian (Meridian's recorded asks hold 100 MON)
    const r = planEarnClose({ perplSide: "buy", sizeWad: 100n * WAD, meridianSizeWad: -100n * WAD, perpl: { side: "Long", sizeWad: 100n * WAD }, ...books });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.meridianSide).toBe("buy");
    expect(r.plan.perplSide).toBe("sell");
    expect(r.plan.perplRefPriceWad).toBe(books.perplBook.bids![0]!.priceWad);
    expect(r.plan.meridianLimitPriceWad % TICK).toBe(0n);
  });
  it("caps by what each venue holds on the pair's side, floored to both steps", () => {
    const r = planEarnClose({ perplSide: "sell", sizeWad: 300n * WAD, meridianSizeWad: 250n * WAD, perpl: { side: "Short", sizeWad: 300n * WAD }, ...books });
    expect(r.ok && r.sizeWad).toBe(200n * WAD);
    const none = planEarnClose({ perplSide: "sell", sizeWad: 300n * WAD, meridianSizeWad: -300n * WAD, perpl: { side: "Short", sizeWad: 300n * WAD }, ...books });
    expect(none.ok).toBe(false);
    expect(planEarnClose({ perplSide: undefined, sizeWad: 0n, meridianSizeWad: 0n, perpl: undefined, ...books }).ok).toBe(false);
  });
});
