import { describe, expect, it } from "vitest";
import { handle } from "../src/api/handler";
import { MfiService } from "../src/mfi/service";
import { PerplUnavailableError } from "../src/perpl";

const E18 = 10n ** 18n;
const T0 = 1_791_234_600_000;
const health = () => ({ ok: true });
function svcWith(n: number) {
  const svc = new MfiService({ chainId: 10143 });
  for (let i = 0; i < n; i++)
    svc.cycle({
      nowMs: T0 + i * 60_000,
      meridian: { ok: true, aprWad: 109_499_999_992_992_000n, windowBlocks: 12_000n, oiNotionalWad: 93_173_850n * 10n ** 15n, markWad: 1n, asOfBlock: 1_000_000n + BigInt(i * 200), headBlock: 1_000_000n + BigInt(i * 200) },
      perpl: i % 2 === 0 ? { ok: true, read: { marketId: 9, aprWad: 105_120_000_000_000_000n, rateMicros: 12, fundingIntervalSec: 3600, fundingEventBlock: 1, fundingAtMs: T0, oiNotionalWad: 1_184_000n * E18, markWad: 1n, stateAtMs: T0 + i * 60_000 } } : { ok: false, error: new PerplUnavailableError("rate-limited", "429") },
    });
  return svc;
}
const isIntStr = (s: unknown) => typeof s === "string" && /^-?\d+$/.test(s);

describe("API contract (docs/MFI.md §7)", () => {
  it("GET /v1/mfi: documented fields and types, CORS, no-store", () => {
    const r = handle(svcWith(1), "GET", "/v1/mfi", T0, health);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
    const b = JSON.parse(JSON.stringify(r.body)) as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(["chainId", "index", "stale", "updatedAt", "updatedBlock", "venues", "venuesIncluded", "version", "warmup"]);
    expect(b.version).toBe("mfi-v0");
    expect(isIntStr((b.index as { aprWad: string }).aprWad)).toBe(true);
    expect(["oi", "equal", "none"]).toContain((b.index as { weighting: string }).weighting);
    expect(typeof b.stale).toBe("boolean");
    expect(isIntStr(b.updatedBlock)).toBe(true);
    expect(Number.isSafeInteger(b.updatedAt)).toBe(true);
    for (const v of b.venues as Record<string, unknown>[]) {
      expect(["meridian", "perpl"]).toContain(v.id);
      expect(typeof v.included).toBe("boolean");
      expect(["ok", "stale", "unavailable", "invalid", "oracle-stale"]).toContain(v.status);
      for (const k of ["aprWad", "oiNotionalWad", "weightOiWad", "asOfBlock"]) if (k in v) expect(isIntStr(v[k]), k).toBe(true);
      if (!v.included) expect(typeof v.reason).toBe("string");
    }
  });
  it("Perpl down: venues says so and venuesIncluded is Meridian only", () => {
    const b = handle(svcWith(2), "GET", "/v1/mfi", T0 + 60_000, health).body as { venuesIncluded: string[]; venues: { id: string; status: string }[] };
    expect(b.venuesIncluded).toEqual(["meridian"]);
    expect(b.venues.find((v) => v.id === "perpl")?.status).toBe("unavailable");
  });
  it("503 before the first cycle; stale flag after 2 min without a cycle", () => {
    expect(handle(new MfiService({ chainId: 10143 }), "GET", "/v1/mfi", T0, health).status).toBe(503);
    expect((handle(svcWith(1), "GET", "/v1/mfi", T0 + 121_000, health).body as { stale: boolean }).stale).toBe(true);
  });
  it("GET /v1/mfi/history: oldest first, range + limit, null perpl when excluded", () => {
    const svc = svcWith(4);
    const b = handle(svc, "GET", `/v1/mfi/history?from=${T0}&to=${T0 + 180_000}&limit=3`, T0 + 180_000, health).body as { version: string; points: Record<string, unknown>[] };
    expect(b.version).toBe("mfi-v0");
    expect(b.points.map((p) => p.updatedAt)).toEqual([T0 + 60_000, T0 + 120_000, T0 + 180_000]);
    expect(b.points[0]).toMatchObject({ perplAprWad: null, venuesIncluded: ["meridian"], meridianAprWad: "109499999992992000", stale: false });
    expect(Object.keys(b.points[0]!).sort()).toEqual(["aprWad", "meridianAprWad", "perplAprWad", "stale", "updatedAt", "updatedBlock", "venuesIncluded"]);
    expect((handle(svc, "GET", "/v1/mfi/history", T0 + 180_000, health).body as { points: unknown[] }).points).toHaveLength(4);
  });
  it("history rejects bad params with 400", () => {
    const svc = svcWith(1);
    for (const q of ["limit=0", "limit=1001", "from=abc", "from=10&to=5", "limit=-1"]) expect(handle(svc, "GET", `/v1/mfi/history?${q}`, T0, health).status, q).toBe(400);
  });
  it("read-only: other methods 405, OPTIONS 204, unknown path 404, /healthz", () => {
    const svc = svcWith(1);
    expect(handle(svc, "POST", "/v1/mfi", T0, health).status).toBe(405);
    expect(handle(svc, "DELETE", "/v1/mfi/history", T0, health).status).toBe(405);
    expect(handle(svc, "OPTIONS", "/v1/mfi", T0, health)).toMatchObject({ status: 204, headers: { "access-control-allow-methods": "GET" } });
    expect(handle(svc, "GET", "/v1/nope", T0, health).status).toBe(404);
    expect(handle(svc, "GET", "/healthz", T0, health)).toMatchObject({ status: 200, body: { ok: true } });
  });
});
