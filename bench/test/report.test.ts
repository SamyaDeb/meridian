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
  it("gas table: Foundry vs estimate vs billed limit, place + cancel summed (30 Sep file: no allowance)", () => {
    const t = renderGasTable({
      foundry: parseCsv("op,gas,target\nplace,68576,\ncancel,27902,\nplace+cancel,96478,100000\n"),
      onchain: parseCsv("op,gasUsed,gasLimit,block\nplace,230865,230865,1\ncancel,140426,140426,2\n"),
      network: "10143",
    });
    expect(t).toContain("| place+cancel | 96,478 | 309,409 | 0 | 371,291 | < 100,000 |");
    expect(t).toContain("| place | 68,576 | 192,388 | 0 | 230,865 |");
    expect(t).toContain("| replace | — | — | — | — |");
  });
  it("Found #19: a legacy file built with the 70k touch allowance derives estimate = (limit − 70k) / 1.2", () => {
    const t = renderGasTable({
      foundry: null,
      onchain: parseCsv("op,gasUsed,gasLimit,block\ncancel,210720,210720,1\n"),
      network: "10143",
      legacyTouchAllowance: 70_000,
    });
    expect(t).toContain("| cancel | — | 117,267 | 70,000 | 210,720 |");
  });
  it("recorded gasEstimate / touchAllowance columns win over the derivation", () => {
    const t = renderGasTable({
      foundry: null,
      onchain: parseCsv("op,gasUsed,gasLimit,block,gasEstimate,touchAllowance\nreplace,280000,280000,1,175000,70000\n"),
      network: "10143",
    });
    expect(t).toContain("| replace | — | 175,000 | 70,000 | 280,000 |");
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
