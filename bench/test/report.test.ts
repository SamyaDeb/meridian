import { describe, expect, it } from "vitest";
import { median, parseCsv, pct, provenance, renderB7, renderGasTable } from "../src/report.js";

describe("report helpers", () => {
  it("parseCsv handles quoted commas", () => {
    expect(parseCsv('design,tau\n"Monad, 1 block",0.3\n')).toEqual([{ design: "Monad, 1 block", tau: "0.3" }]);
    expect(parseCsv("")).toEqual([]);
  });
  it("median / nearest-rank percentile", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(pct([1, 8, 1, 1], 50)).toBe(1);
    expect(pct([1, 8, 1, 1], 95)).toBe(8);
  });
  it("gas table: Foundry vs billed limit, estimate = limit / 1.2, place + cancel summed", () => {
    const t = renderGasTable({
      foundry: parseCsv("op,gas,target\nplace,68576,\ncancel,27902,\nplace+cancel,96478,100000\n"),
      onchain: parseCsv("op,gasUsed,gasLimit,block\nplace,230865,230865,1\ncancel,140426,140426,2\n"),
      network: "10143",
    });
    expect(t).toContain("| place+cancel | 96,478 | 371,291 | 309,409 | < 100,000 |");
    expect(t).toContain("| place | 68,576 | 230,865 | 192,388 |");
    expect(t).toContain("| replace | — | — | — |");
  });
  it("B7 table per network", () => {
    const t = renderB7(parseCsv("network,blocks_after_eligible,blocks_after_push\nanvil,1,3\nanvil,1,1\n10143,8,19\n"));
    expect(t).toContain("| anvil | 2 | 1 | 1 | 1 | 1 | ≤ 3 |");
    expect(t).toContain("| 10143 | 1 | 8 | 8 | 8 | 19 | ≤ 3 |");
  });
  it("provenance", () => {
    expect(provenance(parseCsv("op,block,commit,date,blockTimeMs\na,10,abc,2026-09-30,304.3\nb,12,abc,2026-09-30,304.3\n"))).toBe(
      "blocks 10–12, commit abc, 2026-09-30, measured block time 304.3 ms",
    );
  });
});
