// Terms acceptance (C3). Stored per viewer (this browser) and keyed by version: a new version asks again.

/** Bump when the text in src/content/terms.ts changes materially. */
export const TERMS_VERSION = "2026-10-05-meridian-draft"; // bumped for the Pulse → Meridian rename (decision D5)
export const TERMS_STORAGE_KEY = "pulse.terms.accepted";

export type TermsRecord = { version: string; acceptedAt: number };

export function parseRecord(raw: string | null | undefined): TermsRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<TermsRecord>;
    return typeof r.version === "string" && typeof r.acceptedAt === "number" ? { version: r.version, acceptedAt: r.acceptedAt } : null;
  } catch {
    return null;
  }
}

export function isAccepted(raw: string | null | undefined, version: string = TERMS_VERSION): boolean {
  return parseRecord(raw)?.version === version;
}

export function acceptanceRecord(nowMs: number, version: string = TERMS_VERSION): string {
  return JSON.stringify({ version, acceptedAt: nowMs } satisfies TermsRecord);
}

/** localStorage can throw (private mode, blocked storage): then the viewer is asked again, never let through silently. */
export function readAcceptance(): string | null {
  try {
    return globalThis.localStorage?.getItem(TERMS_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeAcceptance(nowMs: number): void {
  try {
    globalThis.localStorage?.setItem(TERMS_STORAGE_KEY, acceptanceRecord(nowMs));
  } catch {
    // storage unavailable: acceptance lasts for this page session only (kept in React state by the gate)
  }
}
