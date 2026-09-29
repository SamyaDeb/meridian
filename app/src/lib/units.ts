// Protocol units (PulseTypes.sol, MATH_SPEC §0). Money math is bigint; floats only for display.
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n;
export const AUSD_DECIMALS = 6; // verified onchain (ARCHITECTURE R9)
export const AUSD_TO_WAD = 10n ** 12n;
export const BLOCK_TIME_MS = 300; // MATH_SPEC §1.3 nominal; UI cadence only
/** Launch risk params for the UI preview (MATH_SPEC §3.2 / lane brief): mmr 10%, imr 20% ⇒ max 5x. */
export const DEFAULT_MMR_WAD = 10n ** 17n;
export const DEFAULT_IMR_WAD = 2n * 10n ** 17n;
export const MAX_LEVERAGE = 5;
/** MON-PERP tick size 1e-6 AUSD, lot size 100 MON (ARCHITECTURE §0.1). */
export const PERP_TICK_SIZE_WAD = 10n ** 12n;
export const PERP_LOT_SIZE_WAD = 100n * WAD;
/** Default interest floor 10.95% APR (MATH_SPEC §1.3); vault earns when funding > ~15.6% APR (lane brief). */
export const INTEREST_FLOOR_APR_WAD = 1095n * 10n ** 14n;
