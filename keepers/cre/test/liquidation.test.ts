import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { indexerQuery, mergeCandidates, openFromPositionChanges, parseIndexerAccounts, selectLiquidations, shouldUnwind, type AccountSnapshot } from "../shared/liquidation";

const R = getAddress("0x7c44c263225706fe28809bae9fcc13460a908932");
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const snap = (n: number, size: bigint, equity: bigint, mm: bigint, liq = equity < mm): AccountSnapshot => ({ account: a(n), size, equity, maintenanceMargin: mm, liquidatable: liq });

describe("candidates", () => {
  it("dedupes case-insensitively, drops the receiver and junk, caps", () => {
    const out = mergeCandidates([[a(1).toLowerCase(), "nope", R.toLowerCase()], [a(1), a(2)], [a(3)]], R, 2);
    expect(out).toEqual([a(1), a(2)]);
  });

  it("open set from PositionChanged: last write wins, flat dropped", () => {
    const open = openFromPositionChanges([
      { account: a(1), newSize: 5n },
      { account: a(2), newSize: -3n },
      { account: a(1), newSize: 0n },
      { account: a(3), newSize: 0n },
      { account: a(3).toLowerCase(), newSize: 7n },
    ]);
    expect(open.sort()).toEqual([a(2).toLowerCase(), a(3).toLowerCase()].sort());
  });

  it("parses Envio AccountMarket rows for one market only", () => {
    const ch = a(0xc4);
    const body = { data: { AccountMarket: [
      { id: `${ch}-${a(1)}`, size: "100" },
      { id: `${a(0xdd)}-${a(2)}`, size: "5" },
      { id: `${ch.toLowerCase()}-${a(3)}`, size: "0" },
      { id: `${ch}-${a(4)}`, size: "-7" },
    ] } };
    expect(parseIndexerAccounts(body, ch)).toEqual([a(1), a(4)]);
    expect(parseIndexerAccounts({ errors: [] }, ch)).toEqual([]);
    expect(JSON.parse(indexerQuery(ch, 50)).variables).toEqual({ m: ch, n: 50 });
  });
});

describe("selection (confirmed onchain)", () => {
  it("only liquidatable non-flat accounts, most under water first, then size, then address", () => {
    const picks = selectLiquidations([
      snap(1, 10n, 5n, 10n), // shortfall 5
      snap(2, -50n, 0n, 20n), // shortfall 20
      snap(3, 10n, 50n, 10n), // healthy
      snap(4, 0n, 0n, 0n, true), // flat
      snap(6, 20n, 5n, 10n), // shortfall 5, bigger
      snap(5, 20n, 5n, 10n), // tie with 6 → address order
    ]);
    expect(picks).toEqual([a(2), a(5), a(6), a(1)]);
  });

  it("caps at 32 whatever max says", () => {
    const many = Array.from({ length: 40 }, (_, i) => snap(i + 1, 1n, 0n, 1n));
    expect(selectLiquidations(many, 100)).toHaveLength(32);
    expect(selectLiquidations(many, 3)).toHaveLength(3);
  });

  it("unwind only with at least one lot", () => {
    expect(shouldUnwind(0n, 100n)).toBe(false);
    expect(shouldUnwind(99n, 100n)).toBe(false);
    expect(shouldUnwind(-100n, 100n)).toBe(true);
    expect(shouldUnwind(5n, 0n)).toBe(false);
  });
});
