// Launch-cost guard (PHASES decision D13, Phase 3 finding F-5). On a mainnet fork the swap MM with the default
// REQUOTE_BPS=2 requoted every block and burned ≈ 441 MON/h (RUNBOOK §4), because at launch it anchors on the perp's
// current rate, which moves up to 175 APR bps per block. Launch config on 143: REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33
// LEVELS=1 (keepers/143.swap-mm.env.example). The perp MM keeps its defaults.

export const MAINNET_CHAIN_ID = 143;
/** Smallest swap-MM requote threshold (APR bps) allowed on 143 without ALLOW_HIGH_BURN=1. */
export const MIN_SWAP_REQUOTE_BPS_143 = 1000n;

export interface LaunchGuardInput {
  chainId: number;
  market: string;
  requoteBps: bigint;
  allowHighBurn: boolean;
}

/** Returns the reason to refuse to start, or null when the config is allowed. */
export function launchGuard({ chainId, market, requoteBps, allowHighBurn }: LaunchGuardInput): string | null {
  if (chainId !== MAINNET_CHAIN_ID || market !== "swap" || allowHighBurn) return null;
  if (requoteBps >= MIN_SWAP_REQUOTE_BPS_143) return null;
  return (
    `refusing MARKET=swap on chain ${MAINNET_CHAIN_ID} with REQUOTE_BPS=${requoteBps} (< ${MIN_SWAP_REQUOTE_BPS_143}): ` +
    `the swap MM would requote almost every block (≈ 441 MON/h on the fork, RUNBOOK §4). Use ` +
    `REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33 LEVELS=1, or set ALLOW_HIGH_BURN=1 to accept the cost`
  );
}
