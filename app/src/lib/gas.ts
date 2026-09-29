/** Monad charges the gas limit, not gas used (CLAUDE.md §7): limit = estimate × 1.2, rounded up. */
export const gasLimitFromEstimate = (estimate: bigint): bigint => (estimate * 12n + 9n) / 10n;
