import { describe, expect, it } from "vitest";
import { latestIfBalance, meridianRisk } from "./meridianRisk";

const W = 10n ** 18n;
const ops = { mm: ["0xmm"], all: ["0xmm", "0xkeeper"] };
const pos = (account: string | undefined, size: bigint) => ({ ...(account ? { account } : {}), size: size * W, entryPrice: W / 40n, collateralWad: 10n * W });

describe("Meridian risk summary", () => {
  it("operators are out of the user histogram and counts; MM share of OI disclosed", () => {
    const r = meridianRisk([pos("0xa", 1000n), pos("0xa", -100n), pos("0xmm", -900n), pos("0xkeeper", 100n), pos(undefined, 0n)], W / 40n, W / 10n, ops);
    expect(r.users).toBe(1);
    expect(r.operatorPositions).toBe(2);
    expect(r.histogram.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect([r.longWad, r.shortWad]).toEqual([1100n * W, 1000n * W]);
    expect(r.skewBps).toBe(476n); // 100 / 2100 = 4.76 %
    expect(r.mmShortWad).toBe(900n * W);
    expect(r.mmShareBps).toBe(4285n); // 900 / 2100, rounds down
  });
  it("the market's own OI replaces the mirrored sum when known", () => {
    const r = meridianRisk([pos("0xmm", 5n)], W, W / 10n, ops, { longWad: 50n * W, shortWad: 50n * W });
    expect(r.skewBps).toBe(0n);
    expect(r.mmShareBps).toBe(500n);
  });
  it("empty book", () => {
    const r = meridianRisk([], W, W / 10n, ops);
    expect([r.users, r.skewBps, r.mmShareBps]).toEqual([0, 0n, 0n]);
    expect(latestIfBalance([])).toBeUndefined();
    expect(latestIfBalance([{ balanceAfterToken: 1n }, { balanceAfterToken: 9n }])).toBe(9n);
  });
});
