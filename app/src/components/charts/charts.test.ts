import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MfiPoint } from "@/data/mfi";
import { MfiChart, MfiTable } from "./MfiChart";
import { aprPct, fmtPct, lineModel, nearestIndex, niceTicks } from "./model";

const E16 = 10n ** 16n;
const pts: MfiPoint[] = [
  { t: 0, mfi: 10n * E16, meridian: 11n * E16, perpl: 9n * E16, stale: false },
  { t: 60_000, mfi: 11n * E16, meridian: 11n * E16, perpl: null, stale: false },
  { t: 120_000, mfi: -2n * E16, meridian: 5n * E16, perpl: -4n * E16, stale: false },
];

describe("chart model", () => {
  it("aprPct / fmtPct", () => {
    expect(aprPct(105_439_534_777_780_673n)).toBe(10.5439);
    expect(fmtPct(-7.161)).toBe("−7.16%");
  });
  it("nice ticks cover the range and include 0", () => {
    const t = niceTicks(-4, 11);
    expect(t[0]! <= -4 && t[t.length - 1]! >= 11).toBe(true);
    expect(t).toContain(0);
    expect(niceTicks(5, 5).length).toBeGreaterThanOrEqual(2);
  });
  it("lines break at gaps instead of interpolating; last point per series", () => {
    const m = lineModel(pts, 400, 200)!;
    expect(m.paths.perpl.match(/M/g)).toHaveLength(2); // pen lifted at the null
    expect(m.paths.meridian.match(/M/g)).toHaveLength(1);
    expect(m.last.perpl?.pct).toBe(-4);
    expect(nearestIndex(pts, m, m.x(70_000))).toBe(1);
  });
  it("no plottable value ⇒ undefined (page shows the table/empty state)", () => {
    expect(lineModel([], 400, 200)).toBeUndefined();
    expect(lineModel([{ t: 0, mfi: null, meridian: null, perpl: null, stale: true }], 400, 200)).toBeUndefined();
  });
});

describe("components (server render)", () => {
  it("MfiChart: legend for all three series, accessible label, table toggle", () => {
    const html = renderToStaticMarkup(createElement(MfiChart, { points: pts }));
    for (const l of ["MFI", "Meridian", "Perpl"]) expect(html).toContain(l);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Funding APR over time[^"]*Latest MFI −2.00%/);
    expect(html).toContain("Show table");
    expect(html).toContain("var(--viz-1)");
    // the toggle stays reachable in both views (it used to sit inside the aria-hidden legend in table view)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"/);
  });
  it("MfiTable: newest first, n/a for excluded venues", () => {
    const html = renderToStaticMarkup(createElement(MfiTable, { points: pts }));
    expect(html.indexOf("−2.00%")).toBeLessThan(html.indexOf("10.00%"));
    expect(html).toContain("n/a");
    expect(html).toContain("<caption");
  });
});
