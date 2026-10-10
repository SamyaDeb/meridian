import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNS, parseCrashCsv } from "../../../scripts/gen-crash-replay.mjs";
import gen from "./crashReplay.gen.json";
import { CRASH_RUNS } from "./crashReplay";

describe("crash replay", () => {
  it("the generated JSON matches the recorded CSV (rerun scripts/gen-crash-replay.mjs after a new recording)", () => {
    for (const r of RUNS as { id: string; csv: string }[]) {
      const csv = parseCrashCsv(readFileSync(new URL(`../../../../${r.csv}`, import.meta.url), "utf8"));
      expect((gen as { id: string; rows: unknown }[]).find((g) => g.id === r.id)?.rows).toEqual(csv.rows);
    }
  });
  it("local run: index −15 % at block 105,252, the trader liquidated in that block, the IF takes the penalty", () => {
    const run = CRASH_RUNS.find((r) => r.id === "local-10143")!;
    expect(run.label).toMatch(/^Local test market/);
    expect(run.frames).toHaveLength(21);
    expect(run.liquidationBlock).toBe(105_252n);
    const [f0, f1] = run.frames;
    expect(f0!.traderSizeWad).toBe(5_500n * 10n ** 18n);
    expect(f1!.traderSizeWad).toBe(0n);
    expect(f1!.indexWad * 100n / f0!.indexWad).toBe(85n); // 0.0266 → 0.02261
    expect(f1!.ifBalanceToken - f0!.ifBalanceToken).toBe(621_775n); // +0.621775 AUSD penalty share
  });
});
