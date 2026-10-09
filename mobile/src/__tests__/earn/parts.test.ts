// Earn's smaller pieces: the collateral step (no prompt when both venues cover their leg, ONE prompt for both top-ups,
// owed amounts rounded up), the Perpl top-up (approve exactly, skipped when the allowance covers it), the 24 h gap
// series (core funding math, hours without data dropped), and the dev flag staying out of release bundles.
import { perplRateToAprWad, type FundingEvent } from "@meridian/core/perpl";
import { meridianEffectiveAprWad } from "@meridian/core/route";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { ensureEarnCollateral, perplTopUp } from "../../features/earn/collateral";
import { blocksPerHour, gapSeries, GapHistory } from "../../features/earn/history";
import { fs, path, sourceFiles, SRC_DIR } from "../node";

const WAD = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000a1" as Address;

describe("ensureEarnCollateral", () => {
  const deps = (freeM: bigint, freeP: bigint) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        freeMeridian: async () => freeM,
        freePerpl: async () => freeP,
        withFreshSession: async <T,>(fn: (a: never) => Promise<T>) => {
          calls.push("prompt");
          return fn("acct" as never);
        },
        depositMeridian: async (_a: unknown, need: bigint) => void calls.push(`meridian ${need}`),
        depositPerpl: async (_a: unknown, cns: bigint) => void calls.push(`perpl ${cns}`),
        perplCollateralDecimals: 6,
      },
    };
  };
  it("both venues already cover their leg ⇒ no passkey prompt", async () => {
    const { d, calls } = deps(10n * WAD, 10n * WAD);
    expect(await ensureEarnCollateral(d, 5n * WAD, 5n * WAD)).toEqual({ meridian: false, perplCns: 0n });
    expect(calls).toEqual([]);
  });
  it("both short ⇒ one prompt; Perpl's shortfall rounded UP to whole token units", async () => {
    const { d, calls } = deps(0n, 1n * WAD);
    const r = await ensureEarnCollateral(d, 5n * WAD + 1n, 5n * WAD);
    expect(r).toEqual({ meridian: true, perplCns: 4_000_001n });
    expect(calls).toEqual(["prompt", `meridian ${5n * WAD}`, "perpl 4000001"]);
  });
});

describe("perplTopUp", () => {
  it("approves exactly the amount, then depositCollateral; skips approve when the allowance covers it", async () => {
    const sent: { to: Address; data: `0x${string}` }[] = [];
    const run = (allowance: bigint) => perplTopUp({ pub: { readContract: async () => allowance } as never, send: async (r) => void sent.push(r), token: "0x00000000000000000000000000000000000000c1", exchange: "0x00000000000000000000000000000000000000e1", owner: A, amountCns: 4_000_001n });
    await run(0n);
    expect(sent).toHaveLength(2);
    const approve = decodeFunctionData({ abi: erc20Abi, data: sent[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args).toEqual(["0x00000000000000000000000000000000000000e1", 4_000_001n]);
    sent.length = 0;
    await run(10_000_000n);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("0x00000000000000000000000000000000000000e1");
  });
});

describe("gap history", () => {
  const cadence = { blocks: 200n, elapsedMs: 60_000n }; // 300 ms blocks
  const ev = (t: number, rate: number, feb: number): FundingEvent => ({ at: { b: feb, t }, feb, rate, idx: 0, ppl: 0, sum: 0, div: 0 });
  it("one point per Meridian sample with a Perpl rate in force then; |Meridian − Perpl| through core math", () => {
    const pts = gapSeries({ perplEvents: [ev(1_000, 30, 1), ev(5_000, -10, 2)], perplIntervalSec: 2580, meridian: [{ atMs: 500, rateWad: 1n }, { atMs: 2_000, rateWad: 3_000_000_000n }, { atMs: 6_000, rateWad: -2_000_000_000n }], paramBlockTimeMs: 300n, cadence });
    expect(pts.map((p) => p.atMs)).toEqual([2_000, 6_000]); // 500: no Perpl rate yet ⇒ dropped
    const gap = meridianEffectiveAprWad(3_000_000_000n, 300n, cadence) - perplRateToAprWad(30, 2580);
    expect(pts[0]!.gapWad).toBe(gap < 0n ? -gap : gap);
  });
  it("blocks per hour from the measured cadence (rounded down)", () => {
    expect(blocksPerHour(cadence)).toBe(12_000n);
  });
  it("labels the span honestly: '24h' only with real history, else 'session'; live points once a minute", async () => {
    let now = 10 * 3_600_000 * 24;
    const h = new GapHistory({ perplFunding: async () => [], meridianRateAt: async () => 0n, perplIntervalSec: 2580, now: () => now });
    await h.load(1_000_000n, cadence, 300n);
    expect(h.store.get()).toEqual({ points: [], span: "session" });
    h.onLive(5n);
    h.onLive(6n); // same minute ⇒ ignored
    now += 60_000;
    h.onLive(-7n);
    expect(h.store.get().points.map((p) => p.gapWad)).toEqual([5n, 7n]);
    const h24 = new GapHistory({ perplFunding: async () => [ev(now - 30 * 3_600_000, 10, 1)], meridianRateAt: async (b) => (b % 2n === 0n ? 1_000_000_000n : Promise.reject(new Error("pruned"))), perplIntervalSec: 2580, now: () => now });
    await h24.load(1_000_000n, cadence, 300n);
    expect(h24.store.get().span).toBe("24h");
    expect(h24.store.get().points.length).toBe(24);
  });
});

describe("dev flag stays out of release builds", () => {
  it("devFail is required only behind __DEV__, never statically imported", () => {
    const refs = sourceFiles().filter((f) => !f.endsWith(path.join("earn", "devFail.tsx")) && /\.\/devFail"/.test(fs.readFileSync(f, "utf8")));
    expect(refs.map((f) => f.slice(SRC_DIR.length + 1)).sort()).toEqual([path.join("features", "earn", "EarnProvider.tsx"), path.join("features", "earn", "EarnScreen.tsx")]);
    for (const f of refs) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/^import[^\n]*devFail/m);
      expect(src).toMatch(/= __DEV__\s*\?[\s\S]{0,200}require\("\.\/devFail"\)/);
    }
  });
  it("check:release greps the bundle for the dev-flag marker", () => {
    const guard = fs.readFileSync(path.join(SRC_DIR, "..", "scripts", "check-release.mjs"), "utf8");
    expect(guard).toMatch(/meridian-dev-force-meridian-fail/);
  });
});
