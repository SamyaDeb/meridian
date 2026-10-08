// REAL read-only trading session, testnet, 8 Oct 2026 (K3 `scripts/perpl-record-trading.ts 45 0`, hedge account 969):
// sign-in, the three snapshots, then heartbeats. Ported from meridian-k3/mm-bot/test/perpl-recorded.test.ts.
import { describe, expect, it } from "vitest";
import { PerplState, availableCollateral } from "../src/perpl/state";
import { fixtureJson, fixtureLines } from "./helpers";

const frames = fixtureLines<{ recvMs: number; frame: { mt: number } }>("perpl/testnet/trading/trading-session.jsonl");

describe("recorded Perpl trading session (hedge account 969)", () => {
  it("snapshots arrive in the documented order (19, 23, 26) and make the state ready", () => {
    expect(frames.slice(0, 3).map((f) => f.frame.mt)).toEqual([19, 23, 26]);
    const s = new PerplState(64);
    const ev = frames.flatMap((f) => s.apply(f.frame, f.recvMs));
    expect(s.ready).toBe(true);
    expect(ev.filter((e) => e.kind === "gap")).toEqual([]);
    expect(s.account).toMatchObject({ id: 969, fw: true, fr: false, ft: 0, lfr: 0 });
    expect(availableCollateral(s.account!)).toBe(5_000_000_000n); // 5,000 AUSD, 6 dp
    expect(s.netSize()).toBe(0);
    expect(s.head?.block).toBe((frames.at(-1)!.frame as unknown as { h: number }).h);
  });
  it("recorded REST history pages parse as order / fill / position frames", () => {
    const s = new PerplState(64, 969);
    for (const [name, mt] of [["history-order-history", 24], ["history-fills", 25], ["history-position-history", 27]] as const) {
      const rec = fixtureJson<{ pages: { d: unknown[] }[] }>(`perpl/testnet/trading/${name}.json`);
      const rows = rec.pages.flatMap((p) => p.d);
      expect(rows.length).toBeGreaterThan(0);
      expect(() => s.apply({ mt, d: rows }, 0)).not.toThrow();
    }
  });
});
