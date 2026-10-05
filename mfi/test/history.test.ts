import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HISTORY_RETENTION_MS, JsonlHistory, parseHistory } from "../src/mfi/historyStore";
import { MfiService, type CycleInputs, type HistoryPoint } from "../src/mfi/service";
import type { MeridianRead } from "../src/meridian/read";

const T0 = 1_791_234_600_000;
const DAY = 24 * 3600 * 1000;
const meridian: MeridianRead = { ok: true, aprWad: 109_499_999_992_992_000n, windowBlocks: 12_000n, oiNotionalWad: 10n ** 22n, markWad: 3n * 10n ** 16n, asOfBlock: 1n, headBlock: 1n };
const inp = (nowMs: number): CycleInputs => ({ nowMs, meridian, perpl: { ok: false, error: new Error("offline in this test") } });
const pt = (updatedAt: number): HistoryPoint => ({ updatedBlock: "1", updatedAt, aprWad: "5", meridianAprWad: "5", perplAprWad: null, venuesIncluded: ["meridian"], stale: false });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "mfi-history-")), "data", "history.jsonl");

function serviceWith(store: JsonlHistory, nowMs: number) {
  const loaded = store.load(nowMs);
  return { loaded, svc: new MfiService({ chainId: 10143, initialHistory: loaded.points, onHistoryPoint: (p, retained) => store.append(p, retained) }) };
}

describe("MFI history JSONL (decision D7)", () => {
  it("a restart keeps the history: points written by one process are served by the next", () => {
    const path = tmpFile();
    const a = serviceWith(new JsonlHistory(path), T0).svc;
    for (let i = 0; i < 3; i++) a.cycle(inp(T0 + i * 60_000));
    const before = a.historyRange(0, Infinity, 100);
    const { svc: b, loaded } = serviceWith(new JsonlHistory(path), T0 + 180_000);
    expect(loaded).toMatchObject({ corrupt: 0, expired: 0 });
    expect(b.historyRange(0, Infinity, 100)).toEqual(before);
    expect(before).toHaveLength(3);
    b.cycle(inp(T0 + 240_000));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(4); // appended after the reload
  });

  it("trims to 7 days on load (file rewritten) and in memory as time passes", () => {
    const path = tmpFile();
    const store = new JsonlHistory(path);
    store.append(pt(T0 - 8 * DAY), () => []);
    store.append(pt(T0 - DAY), () => []);
    const { svc, loaded } = serviceWith(store, T0);
    expect(loaded).toMatchObject({ expired: 1, corrupt: 0 });
    expect(loaded.points.map((p) => p.updatedAt)).toEqual([T0 - DAY]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    svc.cycle(inp(T0 + 6.5 * DAY)); // the T0 − 1 d point is now 7.5 days old
    expect(svc.historyRange(0, Infinity, 100).map((p) => p.updatedAt)).toEqual([T0 + 6.5 * DAY]);
    expect(HISTORY_RETENTION_MS).toBe(7 * DAY);
  });

  it("corrupt lines are skipped and counted, never guessed", () => {
    const text = [JSON.stringify(pt(T0 - 2)), "{not json", JSON.stringify({ updatedAt: "x" }), JSON.stringify({ ...pt(T0 - 1), aprWad: 0.1 }), "", JSON.stringify(pt(T0 - 1))].join("\n");
    const r = parseHistory(text, T0);
    expect(r).toMatchObject({ corrupt: 3, expired: 0 });
    expect(r.points.map((p) => p.updatedAt)).toEqual([T0 - 2, T0 - 1]);
    const path = tmpFile();
    const store = new JsonlHistory(path);
    store.append(pt(T0 - 2), () => []); // creates the directory
    writeFileSync(path, text);
    expect(store.load(T0)).toMatchObject({ corrupt: 3 });
    expect(parseHistory(readFileSync(path, "utf8"), T0).corrupt).toBe(0); // the rewrite drops them
  });

  it("compacts the file every `compactEvery` appends to the retained set", () => {
    const path = tmpFile();
    const store = new JsonlHistory(path, { compactEvery: 3 });
    const kept = [pt(T0)];
    for (let i = 0; i < 3; i++) store.append(pt(T0 - 10 * DAY + i), () => kept);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
