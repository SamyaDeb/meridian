// Shared row helpers for the indexer readers: a missing root field or a garbled column throws (the UI then says
// "unavailable"), never a silent zero.
export type Raw = Record<string, unknown>;

export function rows(data: unknown, field: string): Raw[] {
  const v = ((data ?? {}) as Record<string, unknown>)[field];
  if (!Array.isArray(v)) throw new Error(`indexer: no ${field} field`);
  return v as Raw[];
}

export function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`indexer: bad ${field}`);
  return v;
}

export const optStr = (v: unknown, field: string) => (v === null || v === undefined ? undefined : str(v, field));

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new Error(`indexer: bad ${field}`);
  return v;
}
