import { planClose } from "../../features/trade/positions/close";

const WAD = 10n ** 18n;

it("a long closes with a reduce-only sell into the bid − 2 %, floored to the price step", () => {
  const p = planClose({ venue: "perpl", sizeWad: 385n * WAD, bestBidWad: 2551n * 10n ** 13n, bestAskWad: 2567n * 10n ** 13n, priceStepWad: 10n ** 13n });
  expect(p).toEqual({ venue: "perpl", side: "sell", sizeWad: 385n * WAD, limitPriceWad: 2499n * 10n ** 13n }); // 0.02551 · 0.98 = 0.0249998 → 0.02499
});

it("a short closes with a buy from the ask + 2 %, ceiled to the tick; the size is positive", () => {
  const p = planClose({ venue: "meridian", sizeWad: -300n * WAD, bestBidWad: undefined, bestAskWad: 25864n * 10n ** 12n, priceStepWad: 10n ** 12n });
  expect(p).toEqual({ venue: "meridian", side: "buy", sizeWad: 300n * WAD, limitPriceWad: 26382n * 10n ** 12n }); // 0.025864 · 1.02 = 0.02638128 → 0.026382
});

it("an empty opposite side or a flat position is a plain error, never a guessed price", () => {
  expect(planClose({ venue: "meridian", sizeWad: 300n * WAD, bestBidWad: undefined, bestAskWad: 1n, priceStepWad: 1n })).toEqual({ error: expect.stringMatching(/No bids on Meridian/) });
  expect(planClose({ venue: "perpl", sizeWad: 0n, bestBidWad: 1n, bestAskWad: 1n, priceStepWad: 1n })).toEqual({ error: "No position to close" });
});
