import { describe, expect, it } from "vitest";
import { parseAddrs, summarize } from "../scripts/tx-cost.js";

describe("tx-cost summarize (Monad bills the gas limit)", () => {
  it("per-hour rates and MON/h from the summed limit, not the used gas", () => {
    const s = [
      { label: "keeper", gasLimit: 120_000n, gasUsed: 100_000n, ok: true },
      { label: "keeper", gasLimit: 120_000n, gasUsed: 100_000n, ok: false },
      { label: "mm", gasLimit: 300_000n, gasUsed: 150_000n, ok: true },
    ];
    const [k, m] = summarize(s, ["keeper", "mm"], 1800, 100n * 10n ** 9n);
    expect(k).toMatchObject({ txs: 2, failed: 1, gasLimit: 240_000n, gasUsed: 200_000n, txPerHour: 4, gasLimitPerHour: 480_000n });
    expect(k!.monPerHourMilli).toBe(48n); // 480k gas/h × 100 gwei = 0.048 MON/h
    expect(m!.gasLimitPerHour).toBe(600_000n);
    expect(() => summarize(s, ["keeper"], 0, 1n)).toThrow();
  });
  it("parses labelled addresses and rejects malformed ones", () => {
    const m = parseAddrs("keeper=0x70997970C51812dc3A010C7d01b50e0d17dc79C8,mm=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect(m.get("0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).toBe("keeper");
    expect(() => parseAddrs("keeper=0x123")).toThrow();
  });
});
