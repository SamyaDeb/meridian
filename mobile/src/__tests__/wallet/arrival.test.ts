import { totalAusdWad } from "../../features/home/total";
import { arrivalText, detectArrival, walletAusdWad } from "../../wallet/arrival";
import type { BalanceState } from "../../wallet/balances";
import { countUpAt, COUNT_UP_MS } from "../../ui/countUp";

const E18 = 10n ** 18n;
const st = (block: bigint | undefined, ausd: bigint | undefined, mon: bigint | undefined, extra: Partial<BalanceState> = {}): BalanceState => ({
  block,
  mon,
  tokens: [{ label: "Test AUSD (Meridian)", amount: ausd, decimals: ausd === undefined ? undefined : 6 }],
  error: undefined,
  ...extra,
});

describe("detectArrival", () => {
  it("first read is never an arrival", () => {
    expect(detectArrival(undefined, st(10n, 5_000_000n, E18))).toEqual([]);
    expect(detectArrival(st(undefined, undefined, undefined), st(10n, 5_000_000n, E18))).toEqual([]);
  });

  it("an AUSD rise names the exact amount", () => {
    const a = detectArrival(st(10n, 0n, E18), st(11n, 12_500_000n, E18));
    expect(a).toEqual([{ symbol: "AUSD", label: "Test AUSD (Meridian)", amountWad: 12_500_000_000_000_000_000n }]);
    expect(arrivalText(a[0]!)).toBe("+12.50 AUSD arrived");
  });

  it("MON rises are reported with 4 decimals", () => {
    const a = detectArrival(st(10n, 0n, 0n), st(11n, 0n, E18 / 2n));
    expect(a.map(arrivalText)).toEqual(["+0.5000 MON arrived"]);
  });

  it("decreases, equal values, read errors and old blocks are not arrivals", () => {
    expect(detectArrival(st(10n, 5n, E18), st(11n, 4n, E18 - 1n))).toEqual([]);
    expect(detectArrival(st(10n, 5n, E18), st(11n, 5n, E18))).toEqual([]);
    expect(detectArrival(st(10n, 5n, E18), st(11n, 9n, E18, { error: "Couldn't read balances on this block" }))).toEqual([]);
    expect(detectArrival(st(11n, 5n, E18), st(11n, 9n, E18))).toEqual([]);
  });

  it("wallet AUSD sums every line and is unknown until all are known", () => {
    const two: BalanceState = { block: 1n, mon: 0n, error: undefined, tokens: [{ label: "a", amount: 1_000_000n, decimals: 6 }, { label: "b", amount: 2_500_000n, decimals: 6 }] };
    expect(walletAusdWad(two)).toBe(3_500_000_000_000_000_000n);
    expect(walletAusdWad({ ...two, tokens: [...two.tokens, { label: "c", amount: undefined, decimals: undefined }] })).toBeUndefined();
    expect(walletAusdWad(undefined)).toBeUndefined();
  });

  it("home total = wallet + venues; any unknown ⇒ unknown", () => {
    expect(totalAusdWad({ walletWad: 5n, venues: [] })).toBe(5n);
    expect(totalAusdWad({ walletWad: 5n, venues: [{ venue: "perpl", equityWad: 7n }] })).toBe(12n);
    expect(totalAusdWad({ walletWad: 5n, venues: [{ venue: "meridian", equityWad: undefined }] })).toBeUndefined();
    expect(totalAusdWad({ walletWad: undefined, venues: [] })).toBeUndefined();
  });
});

describe("countUpAt", () => {
  it("starts at from, ends exactly at to, never overshoots, monotonic", () => {
    const from = 0n;
    const to = 12_500_000_000_000_000_000n;
    expect(countUpAt(from, to, 0)).toBe(from);
    expect(countUpAt(from, to, COUNT_UP_MS)).toBe(to);
    let last = from;
    for (let t = 0; t <= COUNT_UP_MS; t += 16) {
      const v = countUpAt(from, to, t);
      expect(v >= last).toBe(true);
      expect(v <= to).toBe(true);
      last = v;
    }
  });
});
