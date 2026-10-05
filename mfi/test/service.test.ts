import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MfiService, type CycleInputs } from "../src/mfi/service";
import { PerplSchemaError, PerplUnavailableError, type PerplVenueRead } from "../src/perpl";
import type { MeridianRead } from "../src/meridian/read";

const E18 = 10n ** 18n;
const T0 = 1_791_234_600_000;
const meridianOk = (over: Partial<Extract<MeridianRead, { ok: true }>> = {}): MeridianRead => ({ ok: true, aprWad: 109_499_999_992_992_000n, windowBlocks: 12_000n, oiNotionalWad: 93_173_850n * 10n ** 15n, markWad: 29_579n * 10n ** 12n, asOfBlock: 1_000_000n, headBlock: 1_000_000n, ...over });
const perplRead = (nowMs: number, over: Partial<PerplVenueRead> = {}): PerplVenueRead => ({ marketId: 9, aprWad: 105_120_000_000_000_000n, rateMicros: 12, fundingIntervalSec: 3600, fundingEventBlock: 41_231_000, fundingAtMs: nowMs - 600_000, oiNotionalWad: 1_184_000n * E18, markWad: 296n * 10n ** 14n, stateAtMs: nowMs - 1_000, ...over });
const both = (nowMs: number): CycleInputs => ({ nowMs, meridian: meridianOk(), perpl: { ok: true, read: perplRead(nowMs) } });

describe("MfiService cycle", () => {
  it("both venues: MFI.md §8 A, with the documented JSON shape (strings for bigints)", () => {
    const s = new MfiService({ chainId: 10143 }).cycle(both(T0));
    expect(s).toMatchObject({ version: "mfi-v0", chainId: 10143, index: { aprWad: "105439534777780673", weighting: "oi" }, stale: false, warmup: true, updatedBlock: "1000000", updatedAt: T0, venuesIncluded: ["meridian", "perpl"] });
    expect(s.venues.find((v) => v.id === "perpl")).toMatchObject({ included: true, status: "ok", weightBps: 9270, rateMicros: 12, fundingIntervalSec: 3600 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s); // serialisable as is
  });
  it("Perpl unavailable ⇒ Meridian-only, explicit venue flag, never silently wrong", () => {
    const s = new MfiService({ chainId: 10143 }).cycle({ nowMs: T0, meridian: meridianOk(), perpl: { ok: false, error: new PerplUnavailableError("timeout", "timeout after 5000 ms") } });
    expect(s.index).toEqual({ aprWad: "109499999992992000", weighting: "oi" });
    expect(s.venuesIncluded).toEqual(["meridian"]);
    expect(s.venues.find((v) => v.id === "perpl")).toMatchObject({ included: false, status: "unavailable" });
    expect(s.venues.find((v) => v.id === "perpl")?.reason).toMatch(/timeout/);
  });
  it("malformed Perpl payload ⇒ status invalid", () => {
    const s = new MfiService({ chainId: 10143 }).cycle({ nowMs: T0, meridian: meridianOk(), perpl: { ok: false, error: new PerplSchemaError("ticker.d.9.oi", "expected safe integer") } });
    expect(s.venues.find((v) => v.id === "perpl")).toMatchObject({ status: "invalid", included: false });
  });
  it("Perpl funding older than interval + 2 min ⇒ stale and excluded (value still shown)", () => {
    const s = new MfiService({ chainId: 10143 }).cycle({ nowMs: T0, meridian: meridianOk(), perpl: { ok: true, read: perplRead(T0, { fundingAtMs: T0 - 3_600_000 - 120_001 }) } });
    expect(s.venuesIncluded).toEqual(["meridian"]);
    expect(s.venues.find((v) => v.id === "perpl")).toMatchObject({ status: "stale", included: false, aprWad: "105120000000000000" });
  });
  it("Perpl ticker older than 2 min ⇒ stale", () => {
    const s = new MfiService({ chainId: 10143 }).cycle({ nowMs: T0, meridian: meridianOk(), perpl: { ok: true, read: perplRead(T0, { stateAtMs: T0 - 121_000 }) } });
    expect(s.venues.find((v) => v.id === "perpl")?.status).toBe("stale");
  });
  it("Meridian oracle stale ⇒ Perpl-only, flagged", () => {
    const s = new MfiService({ chainId: 10143 }).cycle({ nowMs: T0, meridian: { ok: false, status: "oracle-stale", reason: "OracleStale", headBlock: 1_000_005n }, perpl: { ok: true, read: perplRead(T0) } });
    expect(s.index?.aprWad).toBe("105120000000000000");
    expect(s.venuesIncluded).toEqual(["perpl"]);
    expect(s.updatedBlock).toBe("1000005");
  });
  it("nothing fresh ⇒ keeps the last good value, stale: true, with that value's timestamp", () => {
    const svc = new MfiService({ chainId: 10143 });
    svc.cycle(both(T0));
    const s = svc.cycle({ nowMs: T0 + 60_000, meridian: { ok: false, status: "unavailable", reason: "rpc" }, perpl: { ok: false, error: new Error("down") } });
    expect(s).toMatchObject({ index: { aprWad: "105439534777780673" }, stale: true, updatedAt: T0, venuesIncluded: [] });
    expect(new MfiService({ chainId: 1 }).cycle({ nowMs: T0, meridian: { ok: false, status: "unavailable", reason: "rpc" }, perpl: { ok: false, error: 1 } }).index).toBeNull();
  });
  it("a served snapshot older than 2 min reads stale", () => {
    const svc = new MfiService({ chainId: 10143 });
    svc.cycle(both(T0));
    expect(svc.served(T0 + 120_000)?.stale).toBe(false);
    expect(svc.served(T0 + 120_001)?.stale).toBe(true);
  });
  it("weights use the 1 h minimum OI: a one-cycle Perpl OI pump doesn't move the index", () => {
    const svc = new MfiService({ chainId: 10143 });
    svc.cycle(both(T0));
    const pumped = svc.cycle({ nowMs: T0 + 60_000, meridian: meridianOk(), perpl: { ok: true, read: perplRead(T0 + 60_000, { oiNotionalWad: 100n * 1_184_000n * E18 }) } });
    expect(pumped.index?.aprWad).toBe("105439534777780673");
    expect(pumped.venues.find((v) => v.id === "perpl")?.oiNotionalWad).toBe((100n * 1_184_000n * E18).toString());
  });
  it("history is bounded and range-filtered", () => {
    const svc = new MfiService({ chainId: 10143, historyMax: 5 });
    for (let i = 0; i < 8; i++) svc.cycle(both(T0 + i * 60_000));
    const h = svc.historyRange(0, Number.MAX_SAFE_INTEGER, 1000);
    expect(h).toHaveLength(5);
    expect(h[0]?.updatedAt).toBe(T0 + 3 * 60_000);
    expect(svc.historyRange(T0 + 5 * 60_000, T0 + 6 * 60_000, 10)).toHaveLength(2);
    expect(svc.historyRange(0, Number.MAX_SAFE_INTEGER, 2).map((p) => p.updatedAt)).toEqual([T0 + 6 * 60_000, T0 + 7 * 60_000]);
  });
});

// Replay over a SYNTHETIC recorded-style sequence (fixtures/synthetic/replay.json): no real Perpl recording exists yet
// (sandbox egress denied); swap in fixtures/recorded/ once captured.
describe("replay (synthetic sequence)", () => {
  type Row = { t: number; meridian: { aprWad: string; oiWad: string } | { status: "unavailable" | "oracle-stale" }; perpl: { rateMicros: number; intervalSec: number; oiWad: string; fundingAtMs: number } | { error: "timeout" }; expect: { aprWad: string | null; included: string[] } };
  const rows = (JSON.parse(readFileSync(new URL("../fixtures/synthetic/replay.json", import.meta.url), "utf8")) as { rows: Row[] }).rows;
  it(`reproduces the expected index for all ${rows.length} cycles`, () => {
    const svc = new MfiService({ chainId: 10143 });
    for (const r of rows) {
      const m: MeridianRead = "status" in r.meridian ? { ok: false, status: r.meridian.status, reason: "replay" } : meridianOk({ aprWad: BigInt(r.meridian.aprWad), oiNotionalWad: BigInt(r.meridian.oiWad) });
      const p: CycleInputs["perpl"] = "error" in r.perpl ? { ok: false, error: new PerplUnavailableError("timeout", "replay") } : { ok: true, read: perplRead(r.t, { aprWad: (BigInt(r.perpl.rateMicros) * 10n ** 12n * 31_536_000n) / BigInt(r.perpl.intervalSec), rateMicros: r.perpl.rateMicros, fundingIntervalSec: r.perpl.intervalSec, oiNotionalWad: BigInt(r.perpl.oiWad), fundingAtMs: r.perpl.fundingAtMs, stateAtMs: r.t }) };
      const s = svc.cycle({ nowMs: r.t, meridian: m, perpl: p });
      expect({ t: r.t, aprWad: s.stale ? null : (s.index?.aprWad ?? null), included: s.venuesIncluded }).toEqual({ t: r.t, ...r.expect });
    }
  });
});
