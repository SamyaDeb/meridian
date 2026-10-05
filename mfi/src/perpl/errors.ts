/** Perpl could not be read: the MFI excludes the venue (MFI.md §5) instead of guessing. */
export class PerplUnavailableError extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "http" | "rate-limited" | "not-ready" | "unknown-market",
    message: string,
    readonly status?: number,
    /** server's Retry-After, if any */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PerplUnavailableError";
  }
}

/** Perpl answered, but the payload does not match the documented schema (MFI.md §5 "invalid"). */
export class PerplSchemaError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PerplSchemaError";
  }
}
