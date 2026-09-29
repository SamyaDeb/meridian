import { describe, it, expect } from "vitest";
import * as fx from "./fixtures";
import { createMockSource } from "./source";
import { parseBigints } from "../parse";
import { realizedAprWad } from "@/lib/math";
import type { FundingTick } from "../types";

const head = 400_000n; // > 24 h of blocks

describe("mock data layer (SCHEMA.md shapes)", () => {
  it("funding ticks: newest first, one per block, F and G increasing", () => {
    const t = fx.fundingTicks(head, 50);
    expect(t).toHaveLength(50);
    expect(t[0]!.block).toBe(head);
    t.slice(1).forEach((x, i) => expect(x.block).toBe(t[i]!.block - 1n));
    expect(t[0]!.cumIndexTime > t[49]!.cumIndexTime).toBe(true);
    expect(t[0]!.id).toBe(`${fx.MOCK.clearingHouse}-${head}`);
    expect(t[0]!.rateAprWad).toBe(t[0]!.rate * 31_536_000n);
  });

  it("market realized APR windows equal ΔF/ΔG·YEAR over the same ticks", () => {
    const m = fx.market(head);
    const then = fx.fundingTick(head - 12_000n);
    const now = fx.fundingTick(head);
    expect(m.realizedApr1hWad).toBe(realizedAprWad(then.cumFunding, then.cumIndexTime, now.cumFunding, now.cumIndexTime));
    expect(fx.market(100n).realizedApr24hWad).toBeUndefined();
  });

  it("vault never reports an APY without history", () => {
    expect(fx.vault(10n).apy24hWad).toBeUndefined();
    expect(fx.vault(head).apy24hWad).toBeDefined();
  });

  it("mock source advances one block per 300 ms", async () => {
    let now = fx.MOCK.genesisMs + 3_000;
    const ds = createMockSource(() => now);
    expect((await ds.market()).lastFundingBlock).toBe(10n);
    now += 300;
    expect((await ds.market()).lastFundingBlock).toBe(11n);
    expect(ds.kind).toBe("mock");
  });

  it("parseBigints turns Hasura decimal strings into bigint", () => {
    const raw = { id: "x-1", block: "12", rate: "-3", cumFunding: "1000000000000000000000", realized: null };
    const t = parseBigints<FundingTick & { realized?: bigint }>(raw, ["block", "rate", "cumFunding", "realized"]);
    expect(t.block).toBe(12n);
    expect(t.rate).toBe(-3n);
    expect(t.cumFunding).toBe(10n ** 21n);
    expect(t.realized).toBeUndefined();
    expect(() => parseBigints({ a: true }, ["a"])).toThrow();
  });
});
