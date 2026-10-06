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

describe("initialRange", () => {
  it("fits short histories and frames the newest INITIAL_BARS bars of long ones", async () => {
    const { INITIAL_BARS, initialRange } = await import("./LightweightEngine");
    expect(initialRange(0)).toBeNull();
    expect(initialRange(INITIAL_BARS)).toBeNull();
    expect(initialRange(1_000)).toEqual({ from: 1_000 - INITIAL_BARS, to: 1_002 });
  });
});
