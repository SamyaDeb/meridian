import { describe, expect, it } from "vitest";
import { B4_CSV_HEADER, type B4Tx, b4CsvRow, b4Schedule, interference, sharedBlocks, storageOverlap, summarizeB4 } from "../src/b4.js";

const tx = (o: Partial<B4Tx>): B4Tx => ({
  phase: "a",
  market: "MON-PERP",
  op: "place",
  wallet: 0,
  hash: "0x1",
  sentBlock: 100n,
  sentMs: 1000,
  gasLimit: 120n,
  estimate: 100n,
  ...o,
});

describe("b4Schedule", () => {
  it("is deterministic, cancels only what was placed, mixes all three ops", () => {
    const s = b4Schedule(200, 7);
    expect(b4Schedule(200, 7)).toEqual(s);
    expect(b4Schedule(200, 8)).not.toEqual(s);
    let open = 0;
    for (const x of s) {
      if (x.op === "place") open++;
      if (x.op === "cancel") open--;
      expect(open).toBeGreaterThanOrEqual(0);
    }
    const n = (op: string) => s.filter((x) => x.op === op).length;
    expect(n("place")).toBeGreaterThan(60);
    expect(n("cancel")).toBeGreaterThan(30);
    expect(n("market")).toBeGreaterThan(20);
  });
  it("market orders alternate buy / sell (the wallet stays ≈ flat)", () => {
    const m = b4Schedule(300, 3).filter((x) => x.op === "market");
    m.forEach((x, i) => expect(x.buy).toBe(i % 2 === 0));
  });
});

describe("summarizeB4", () => {
  const txs: B4Tx[] = [
    tx({ block: 101n, seenMs: 1400, status: "success", gasUsed: 70n }),
    tx({ block: 101n, seenMs: 1500, status: "success", gasUsed: 80n, op: "cancel" }),
    tx({ block: 103n, seenMs: 2000, status: "reverted", gasUsed: 90n, op: "market" }),
    tx({}), // not included
    tx({ phase: "ab", block: 200n, seenMs: 1300, status: "success" }),
    tx({ market: "ETH-PERP", block: 101n, seenMs: 1100, status: "success" }),
  ];
  it("per phase and market", () => {
    const s = summarizeB4(txs, "a", "MON-PERP");
    expect(s).toMatchObject({ sent: 4, included: 3, reverted: 1, blocks: 2, txPerBlockMax: 2, txPerBlockMean: 1.5 });
    expect(s.inclusionBlocksP50).toBe(1);
    expect(s.inclusionBlocksP95).toBe(3);
    expect(s.latencyMsP50).toBe(500);
    expect(s.gasUsedP50ByOp).toEqual({ place: 70, cancel: 80 }); // reverted market excluded
    expect(s.estimateP50ByOp).toEqual({ place: 100, cancel: 100 });
  });
  it("empty selection is all zeros", () => {
    expect(summarizeB4([], "b", "ETH-PERP")).toMatchObject({ sent: 0, included: 0, txPerBlockMean: 0, latencyMsP50: 0 });
  });
});

describe("sharedBlocks / interference", () => {
  it("counts joint-phase blocks that carry both markets", () => {
    const t = [
      tx({ phase: "ab", block: 1n }),
      tx({ phase: "ab", block: 1n, market: "ETH-PERP" }),
      tx({ phase: "ab", block: 2n }),
      tx({ phase: "a", block: 3n, market: "ETH-PERP" }),
    ];
    expect(sharedBlocks(t, "MON-PERP", "ETH-PERP")).toEqual({ blocks: 2, shared: 1 });
  });
  it("ratio joint / alone", () => {
    expect(interference(2, 3)).toBe(1.5);
    expect(interference(0, 3)).toBe(0);
  });
});

describe("storageOverlap", () => {
  it("finds shared (address, slot) pairs, case-insensitive, with an ignore list", () => {
    const a = { "0xAA": { storage: { "0x01": "x", "0x02": "y" } }, "0xCC": { storage: { "0x09": "z" } }, "0xEE": {} };
    const b = { "0xaa": { storage: { "0x02": "y" } }, "0xBB": { storage: { "0x01": "q" } }, "0xcc": { storage: { "0x09": "z" } } };
    const o = storageOverlap(a, b);
    expect(o.shared).toEqual(["0xaa:0x02", "0xcc:0x09"]);
    expect(o.sharedAddresses).toEqual(["0xaa", "0xcc"]);
    expect(o.aSlots).toBe(3);
    expect(o.bSlots).toBe(3);
    expect(storageOverlap(a, b, ["0xCC"]).shared).toEqual(["0xaa:0x02"]);
  });
  it("disjoint markets share nothing", () => {
    expect(storageOverlap({ "0x1": { storage: { "0x0": "1" } } }, { "0x2": { storage: { "0x0": "1" } } }).shared).toEqual([]);
  });
});

describe("CSV", () => {
  it("row matches header and never carries an RPC URL", () => {
    const row = b4CsvRow(tx({ block: 105n, seenMs: 1600, status: "success", gasUsed: 70n }), { chainId: 10143, rpcTier: "private", commit: "abc", date: "2026-10-08" });
    expect(row.split(",")).toHaveLength(B4_CSV_HEADER.split(",").length);
    expect(row).toContain(",5,600,success,");
    expect(row).not.toMatch(/https?:/);
  });
});
