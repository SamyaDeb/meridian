import { describe, expect, it } from "vitest";
import { type BatchIo, gasLimitFor, sendBatch } from "../src/send.js";

type Tx = { id: string; est: bigint | "revert" };

function fakeIo(events: string[]): BatchIo<Tx, string> {
  let n = 0;
  return {
    estimate: async (tx) => {
      events.push(`est:${tx.id}`);
      if (tx.est === "revert") throw new Error("would revert");
      return tx.est;
    },
    send: async (tx, gas) => {
      events.push(`send:${tx.id}:${gas}`);
      return `0x${(n++).toString(16).padStart(2, "0")}` as `0x${string}`;
    },
    wait: async (h) => {
      events.push(`wait:${h}`);
      return `rcpt${h}`;
    },
  };
}

describe("gasLimitFor", () => {
  it("is ceil(est × 1.2)", () => {
    expect(gasLimitFor(100n)).toBe(120n);
    expect(gasLimitFor(101n)).toBe(122n);
  });
});

describe("sendBatch", () => {
  it("pipelines: every send happens before the first receipt is awaited, in order, with the max-estimate limit", async () => {
    const ev: string[] = [];
    const txs: Tx[] = [
      { id: "a", est: 150_000n },
      { id: "b", est: 180_000n },
      { id: "c", est: 160_000n },
    ];
    const r = await sendBatch(txs, fakeIo(ev));
    expect(r.pipelined).toBe(true);
    expect(r.gasLimits).toEqual([216_000n, 216_000n, 216_000n]);
    expect(r.receipts).toEqual(["rcpt0x00", "rcpt0x01", "rcpt0x02"]);
    const sends = ev.filter((e) => e.startsWith("send:"));
    expect(sends).toEqual(["send:a:216000", "send:b:216000", "send:c:216000"]);
    expect(ev.findIndex((e) => e.startsWith("wait:"))).toBeGreaterThan(ev.lastIndexOf("send:c:216000"));
  });

  it("falls back to one-at-a-time when a tx only estimates after an earlier one lands", async () => {
    const ev: string[] = [];
    const txs: Tx[] = [
      { id: "a", est: 100_000n },
      { id: "b", est: "revert" },
    ];
    const r = await sendBatch(txs, fakeIo(ev)).catch((e: unknown) => e);
    // b still reverts in the sequential path (the fake never changes state), and nothing after it is sent
    expect(r).toBeInstanceOf(Error);
    expect(ev).toEqual(["est:a", "est:b", "est:a", "send:a:120000", "wait:0x00", "est:b"]);
  });

  it("sequential path uses per-tx limits", async () => {
    const ev: string[] = [];
    let first = true;
    const io = fakeIo(ev);
    const flaky: BatchIo<Tx, string> = {
      ...io,
      estimate: async (tx) => {
        if (tx.id === "b" && first) {
          first = false;
          throw new Error("not yet");
        }
        return io.estimate(tx);
      },
    };
    const txs: Tx[] = [
      { id: "a", est: 100_000n },
      { id: "b", est: 200_000n },
    ];
    const r = await sendBatch(txs, flaky);
    expect(r.pipelined).toBe(false);
    expect(r.gasLimits).toEqual([120_000n, 240_000n]);
    expect(r.receipts).toEqual(["rcpt0x00", "rcpt0x01"]);
  });

  it("empty batch is a no-op", async () => {
    const ev: string[] = [];
    expect(await sendBatch([] as Tx[], fakeIo(ev))).toEqual({ receipts: [], gasLimits: [], pipelined: true });
    expect(ev).toEqual([]);
  });
});
