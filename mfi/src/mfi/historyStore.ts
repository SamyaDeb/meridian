// MFI history persistence (MFI.md §9 option A, owner decision D7): append-only JSONL, one HistoryPoint per cycle.
// Reloaded on start, trimmed to the retention window (7 days), rewritten (temp file + rename) on start and once per
// `compactEvery` appends so the file stays bounded. No fsync: losing the last few points on a crash is acceptable.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryPoint } from "./service";

export const HISTORY_RETENTION_MS = 7 * 24 * 3600 * 1000;

const VENUES = new Set(["meridian", "perpl"]);
const wadOrNull = (v: unknown) => v === null || (typeof v === "string" && /^-?\d+$/.test(v));

/** Shape check for one stored line; anything else is a corrupt line (skipped and counted, never guessed). */
export function isHistoryPoint(v: unknown): v is HistoryPoint {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    Number.isSafeInteger(p.updatedAt) &&
    (p.updatedAt as number) >= 0 &&
    (p.updatedBlock === null || (typeof p.updatedBlock === "string" && /^\d+$/.test(p.updatedBlock))) &&
    wadOrNull(p.aprWad) &&
    wadOrNull(p.meridianAprWad) &&
    wadOrNull(p.perplAprWad) &&
    Array.isArray(p.venuesIncluded) &&
    p.venuesIncluded.every((x) => typeof x === "string" && VENUES.has(x)) &&
    typeof p.stale === "boolean"
  );
}

export type LoadedHistory = { points: HistoryPoint[]; corrupt: number; expired: number };

/** Pure: JSONL text → points within [nowMs − retentionMs, ∞), oldest first. Blank lines are ignored. */
export function parseHistory(text: string, nowMs: number, retentionMs = HISTORY_RETENTION_MS): LoadedHistory {
  const points: HistoryPoint[] = [];
  let corrupt = 0;
  let expired = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      corrupt++;
      continue;
    }
    if (!isHistoryPoint(v)) {
      corrupt++;
      continue;
    }
    if (v.updatedAt < nowMs - retentionMs) {
      expired++;
      continue;
    }
    points.push(v);
  }
  points.sort((a, b) => a.updatedAt - b.updatedAt);
  return { points, corrupt, expired };
}

export class JsonlHistory {
  private sinceCompact = 0;
  constructor(
    readonly path: string,
    private readonly opts: { retentionMs?: number; compactEvery?: number } = {},
  ) {}

  /** Reads the file (missing ⇒ empty) and rewrites it with only the retained, valid points. */
  load(nowMs: number): LoadedHistory {
    const text = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    const r = parseHistory(text, nowMs, this.opts.retentionMs);
    this.rewrite(r.points);
    return r;
  }

  append(p: HistoryPoint, retained: () => readonly HistoryPoint[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(p)}\n`);
    if (++this.sinceCompact >= (this.opts.compactEvery ?? 1440)) this.rewrite(retained());
  }

  private rewrite(points: readonly HistoryPoint[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, points.map((p) => `${JSON.stringify(p)}\n`).join(""));
    renameSync(tmp, this.path);
    this.sinceCompact = 0;
  }
}
