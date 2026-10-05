import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCrash, parseCrashCsv } from "../src/crashSanity.js";

const read = (f: string) => readFileSync(new URL(`../out/${f}`, import.meta.url), "utf8");

describe("CrashDemo CSV sanity", () => {
  it("passes the mainnet-fork run with MM-bot behaviour (labelled, idle vault)", () => {
    const rows = parseCrashCsv(read("crash_demo_143fork.csv"));
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(checkCrash(rows, { vault: "idle" })).toEqual([]);
  });

  it("flags the stale-wall finding run: the trader is never liquidated", () => {
    const f = checkCrash(parseCrashCsv(read("crash_demo_143fork_stalewall.csv")), { vault: "idle" });
    expect(f).toContain("trader never liquidated");
  });

  it("catches an IF drop, an idle NAV change, a mark outside the band and too few blocks", () => {
    const rows = parseCrashCsv(read("crash_demo_143fork.csv"));
    const bad = rows.map((r) => ({ ...r }));
    bad[5]!.ifBalance -= 1n;
    bad[6]!.nav += 1n;
    bad[7]!.mark = (bad[7]!.index * 106n) / 100n;
    const f = checkCrash(bad, { vault: "idle" });
    expect(f.some((x) => x.includes("IF balance fell"))).toBe(true);
    expect(f.some((x) => x.includes("idle vault NAV changed"))).toBe(true);
    expect(f.some((x) => x.includes("outside index ± 5%"))).toBe(true);
    expect(checkCrash(rows.slice(0, 10), { vault: "idle" }).some((x) => x.includes("blocks after the start row"))).toBe(true);
  });

  it("allows a hedged vault's NAV to move within 0.5% but not more", () => {
    const rows = parseCrashCsv(read("crash_demo_143fork.csv"));
    const drift = rows.map((r, i) => ({ ...r, nav: r.nav + BigInt(i) * 100n }));
    expect(checkCrash(drift, { vault: "hedged" })).toEqual([]);
    const big = rows.map((r, i) => ({ ...r, nav: i > 3 ? (r.nav * 101n) / 100n : r.nav }));
    expect(checkCrash(big, { vault: "hedged" }).some((x) => x.includes("moved > 0.5%"))).toBe(true);
  });
});
