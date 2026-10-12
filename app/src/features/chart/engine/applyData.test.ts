import { describe, expect, it } from "vitest";
import { applyData } from "./LightweightEngine";

/** Fake series with the library's rule: update() may only touch the last bar or append a later one. */
function fakeSeries() {
  let rows: { time: number }[] = [];
  const calls: string[] = [];
  const ser = {
    setData(d: { time: number }[]) {
      rows = [...d];
      calls.push("set");
    },
    update(p: { time: number }) {
      const last = rows[rows.length - 1];
      if (last && p.time < last.time) throw new Error("Cannot update oldest data");
      if (last && p.time === last.time) rows[rows.length - 1] = p;
      else rows.push(p);
      calls.push("update");
    },
  };
  return { ser: ser as never, calls, rows: () => rows };
}

describe("applyData", () => {
  it("updates the newest bar in place, appends a later one, skips identical data", () => {
    const { ser, calls } = fakeSeries();
    const seen = new Map();
    applyData(ser, [{ time: 60, value: 1 }, { time: 120, value: 2 }], seen);
    applyData(ser, [{ time: 60, value: 1 }, { time: 120, value: 3 }], seen);
    applyData(ser, [{ time: 60, value: 1 }, { time: 120, value: 3 }, { time: 180, value: 4 }], seen);
    applyData(ser, [{ time: 60, value: 1 }, { time: 120, value: 3 }, { time: 180, value: 4 }], seen);
    expect(calls).toEqual(["set", "update", "update"]);
  });
  it("a newest point whose time moved earlier re-sets the data instead of throwing (session time re-estimate)", () => {
    const { ser, calls, rows } = fakeSeries();
    const seen = new Map();
    applyData(ser, [{ time: 60, value: 1 }, { time: 125, value: 2 }], seen);
    expect(() => applyData(ser, [{ time: 60, value: 1 }, { time: 121, value: 2 }], seen)).not.toThrow();
    expect(calls).toEqual(["set", "set"]);
    expect(rows().map((r) => r.time)).toEqual([60, 121]);
  });
});

describe("default view", () => {
  it("opens at a fixed candle width with the newest bar inset from the right (never fit-to-width)", async () => {
    const { BAR_SPACING, RIGHT_OFFSET_BARS } = await import("./LightweightEngine");
    expect(BAR_SPACING).toBe(6);
    expect(RIGHT_OFFSET_BARS).toBe(10);
  });
});
