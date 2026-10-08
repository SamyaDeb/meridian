// bigint-safe JSON: bigints are written as { "$bigint": "<decimal>" } and read back exactly (persisted exec state).

type Tagged = { $bigint: string };
const isTagged = (v: unknown): v is Tagged =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Tagged).$bigint === "string";

export function stringifyBig(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? ({ $bigint: x.toString() } satisfies Tagged) : x));
}

export function parseBig(text: string): unknown {
  return JSON.parse(text, (_k, x: unknown) => {
    if (!isTagged(x)) return x;
    if (!/^-?\d+$/.test(x.$bigint)) throw new Error(`parseBig: bad bigint "${x.$bigint}"`);
    return BigInt(x.$bigint);
  });
}
