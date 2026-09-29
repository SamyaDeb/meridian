// Hasura returns BigInt columns as decimal strings. Convert an entity's listed fields to bigint.
type Raw = Record<string, unknown>;

export function parseBigints<T>(raw: Raw, fields: readonly string[]): T {
  const out: Raw = { ...raw };
  for (const f of fields) {
    const v = raw[f];
    if (v === null || v === undefined) out[f] = undefined;
    else if (typeof v === "string" || typeof v === "number") out[f] = BigInt(v);
    else if (typeof v !== "bigint") throw new TypeError(`parseBigints: ${f} is ${typeof v}`);
  }
  return out as T;
}
