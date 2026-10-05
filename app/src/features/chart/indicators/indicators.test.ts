// Hand-computed fixtures (worked by hand, written out below each case).
import { describe, expect, it } from "vitest";
import { bollinger, ema, macd, rsi, sma } from ".";

const close = (a: (number | undefined)[], b: (number | undefined)[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => (b[i] === undefined ? expect(x).toBeUndefined() : expect(x).toBeCloseTo(b[i]!, 6)));
};

describe("SMA", () => {
  it("SMA(3) of 1..6 = 2,3,4,5", () => close(sma([1, 2, 3, 4, 5, 6], 3), [undefined, undefined, 2, 3, 4, 5]));
  it("period 1 is the identity; bad period throws", () => {
    close(sma([4, 7], 1), [4, 7]);
    expect(() => sma([1], 0)).toThrow();
  });
});

describe("EMA", () => {
  // n=3, k=0.5. seed = mean(2,4,6) = 4; then 8·0.5+4·0.5 = 6; 10·0.5+6·0.5 = 8
  it("EMA(3) of 2,4,6,8,10 = 4,6,8 (SMA seed, k = 2/(n+1))", () => close(ema([2, 4, 6, 8, 10], 3), [undefined, undefined, 4, 6, 8]));
  it("constant series stays constant", () => close(ema([5, 5, 5, 5], 2), [undefined, 5, 5, 5]));
});

describe("Bollinger", () => {
  // window [2,4,4,4,5,5,7,9]: mean 5, population σ = 2 ⇒ bands 1 and 9 at k = 2
  it("textbook σ = 2 example", () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.middle[7]).toBeCloseTo(5, 9);
    expect(b.upper[7]).toBeCloseTo(9, 9);
    expect(b.lower[7]).toBeCloseTo(1, 9);
    expect(b.upper[6]).toBeUndefined();
  });
});

describe("RSI (Wilder)", () => {
  // n=2 on 1,2,1,3: changes +1,−1,+2. First avg gain = (1+0)/2 = 0.5, loss = (0+1)/2 = 0.5 ⇒ RSI 50.
  // next: gain = (0.5·1 + 2)/2 = 1.25, loss = (0.5·1 + 0)/2 = 0.25 ⇒ RS 5 ⇒ RSI = 100 − 100/6 = 83.333…
  it("hand-computed n = 2", () => close(rsi([1, 2, 1, 3], 2), [undefined, undefined, 50, 100 - 100 / 6]));
  it("only gains ⇒ 100, flat ⇒ 50, bounded in [0, 100]", () => {
    expect(rsi([1, 2, 3, 4], 2)[3]).toBe(100);
    expect(rsi([3, 3, 3], 2)[2]).toBe(50);
    for (const v of rsi([5, 3, 8, 1, 9, 2, 7, 7, 4], 3)) if (v !== undefined) expect(v >= 0 && v <= 100).toBe(true);
  });
});

describe("MACD", () => {
  // fast 2 (k=2/3), slow 3 (k=1/2), signal 2 on 1,2,3,4,5:
  // EMA2: -,1.5,2.5,3.5,4.5   EMA3: -,-,2,3,4   line: -,-,0.5,0.5,0.5   signal EMA2 of 0.5,0.5,0.5: -,0.5,0.5
  it("hand-computed small periods", () => {
    const m = macd([1, 2, 3, 4, 5], 2, 3, 2);
    close(m.line, [undefined, undefined, 0.5, 0.5, 0.5]);
    close(m.signal, [undefined, undefined, undefined, 0.5, 0.5]);
    close(m.histogram, [undefined, undefined, undefined, 0, 0]);
  });
  it("too little data ⇒ all undefined", () => {
    const m = macd([1, 2], 12, 26, 9);
    expect(m.line.every((x) => x === undefined)).toBe(true);
    expect(m.signal.every((x) => x === undefined)).toBe(true);
  });
});
