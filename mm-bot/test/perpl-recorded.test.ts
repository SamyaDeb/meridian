import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PerplState, availableCollateral } from "../src/perpl/state";

// REAL read-only trading session, testnet, 8 Oct 2026 (`scripts/perpl-record-trading.ts 45 0`): sign-in, the three
// snapshots, then heartbeats; no pings sent and the socket stayed open 45 s (the idle timeout applies before sign-in only).
const frames = readFileSync(new URL("../fixtures/recorded/testnet/trading-session.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { recvMs: number; frame: { mt: number } });

describe("recorded Perpl trading session (hedge account 969)", () => {
  it("snapshots arrive in the documented order (19, 23, 26) and make the state ready", () => {
    expect(frames.slice(0, 3).map((f) => f.frame.mt)).toEqual([19, 23, 26]);
    const s = new PerplState(64);
    const ev = frames.flatMap((f) => s.apply(f.frame, f.recvMs));
    expect(s.ready).toBe(true);
    expect(ev.filter((e) => e.kind === "gap")).toEqual([]); // heartbeat sn = wallet snapshot sn + 1, +1 each
    expect(s.account).toMatchObject({ id: 969, fw: true, fr: false, ft: 0, lfr: 0 });
    expect(availableCollateral(s.account!)).toBe(5_000_000_000n); // 5,000 AUSD, 6 dp
    expect(s.netSize()).toBe(0);
    expect(s.head?.block).toBe((frames.at(-1)!.frame as unknown as { h: number }).h);
  });
});
