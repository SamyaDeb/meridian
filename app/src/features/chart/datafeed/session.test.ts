import { describe, expect, it } from "vitest";
import { appendSample, recordSample, sessionSamples } from "./session";

const S = (time: number, mark = 1n, index = 1n) => ({ time, mark, index });

describe("session samples", () => {
  it("one sample per second (last wins), out-of-order ignored", () => {
    const l = appendSample(appendSample(appendSample([], S(10, 1n)), S(10, 2n)), S(11, 3n));
    expect(l.map((x) => [x.time, x.mark])).toEqual([
      [10, 2n],
      [11, 3n],
    ]);
    expect(appendSample(l, S(5)).length).toBe(2);
  });
  it("bounded: oldest dropped", () => {
    let l = [] as ReturnType<typeof S>[];
    for (let t = 0; t < 10; t++) l = appendSample(l, S(t), 4);
    expect(l.map((x) => x.time)).toEqual([6, 7, 8, 9]);
  });
  it("per market, case-insensitive; zero prices are not recorded", () => {
    recordSample("0xAB", S(1, 5n, 5n));
    recordSample("0xab", S(2, 6n, 6n));
    recordSample("0xab", S(3, 0n, 0n));
    expect(sessionSamples("0xAb").map((x) => x.time)).toEqual([1, 2]);
    expect(sessionSamples("0xcd")).toEqual([]);
  });
});
