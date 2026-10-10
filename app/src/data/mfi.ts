// MFI API client (docs/MFI.md §7). NEXT_PUBLIC_MFI_URL unset ⇒ the Rates page says so; no fake data.
export const MFI_URL = process.env.NEXT_PUBLIC_MFI_URL || undefined;

export type MfiVenue = { id: "meridian" | "perpl"; included: boolean; status: string; reason?: string; aprWad?: bigint; weightBps?: number };
export type MfiCurrent = { aprWad: bigint | null; weighting: string; stale: boolean; warmup: boolean; updatedBlock: bigint | null; updatedAt: number; venues: MfiVenue[] };
export type MfiPoint = { t: number; mfi: bigint | null; meridian: bigint | null; perpl: bigint | null; spread?: bigint | null; stale: boolean };

type Raw = Record<string, unknown>;
const obj = (v: unknown, f: string): Raw => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`mfi: bad ${f}`);
  return v as Raw;
};
const bigStr = (v: unknown, f: string): bigint => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`mfi: bad ${f}`);
};
const optBig = (v: unknown, f: string) => (v === null || v === undefined ? null : bigStr(v, f));
const ms = (v: unknown, f: string) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`mfi: bad ${f}`);
  return v;
};
const bool = (v: unknown, f: string) => {
  if (typeof v !== "boolean") throw new Error(`mfi: bad ${f}`);
  return v;
};

/** Pure: GET /v1/mfi body → MfiCurrent. Throws on schema mismatch (the page then shows "unavailable"). */
export function parseMfiCurrent(body: unknown): MfiCurrent {
  const b = obj(body, "body");
  if (b.version !== "mfi-v0") throw new Error("mfi: unsupported version");
  const idx = b.index === null ? null : obj(b.index, "index");
  if (!Array.isArray(b.venues)) throw new Error("mfi: bad venues");
  return {
    aprWad: idx ? bigStr(idx.aprWad, "index.aprWad") : null,
    weighting: idx ? String(idx.weighting) : "none",
    stale: bool(b.stale, "stale"),
    warmup: bool(b.warmup, "warmup"),
    updatedBlock: optBig(b.updatedBlock, "updatedBlock"),
    updatedAt: ms(b.updatedAt, "updatedAt"),
    venues: b.venues.map((x, i) => {
      const v = obj(x, `venues[${i}]`);
      if (v.id !== "meridian" && v.id !== "perpl") throw new Error(`mfi: bad venues[${i}].id`);
      const out: MfiVenue = { id: v.id, included: bool(v.included, `venues[${i}].included`), status: String(v.status) };
      if (typeof v.reason === "string") out.reason = v.reason;
      if (v.aprWad !== undefined) out.aprWad = bigStr(v.aprWad, `venues[${i}].aprWad`);
      if (typeof v.weightBps === "number") out.weightBps = v.weightBps;
      return out;
    }),
  };
}

/** Pure: GET /v1/mfi/history body → points, oldest first. */
export function parseMfiHistory(body: unknown): MfiPoint[] {
  const b = obj(body, "body");
  if (b.version !== "mfi-v0" || !Array.isArray(b.points)) throw new Error("mfi: bad history");
  return b.points.map((x, i) => {
    const p = obj(x, `points[${i}]`);
    return { t: ms(p.updatedAt, `points[${i}].updatedAt`), mfi: optBig(p.aprWad, "aprWad"), meridian: optBig(p.meridianAprWad, "meridianAprWad"), perpl: optBig(p.perplAprWad, "perplAprWad"), stale: bool(p.stale, "stale") };
  });
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`mfi: HTTP ${res.status}`);
  return res.json();
}
export const fetchMfiCurrent = async (base: string, signal?: AbortSignal) => parseMfiCurrent(await getJson(`${base.replace(/\/+$/, "")}/v1/mfi`, signal));
export const fetchMfiHistory = async (base: string, limit: number, signal?: AbortSignal) => parseMfiHistory(await getJson(`${base.replace(/\/+$/, "")}/v1/mfi/history?limit=${limit}`, signal));
