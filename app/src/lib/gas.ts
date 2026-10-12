/** Monad charges the gas limit, not gas used (CONTRIBUTING.md §7): limit = estimate × 1.2, rounded up. */
export const gasLimitFromEstimate = (estimate: bigint): bigint => (estimate * 12n + 9n) / 10n;

/**
 * Extra gas for a call that may be the first to touch a market's funding state in its block (≈ 70k on Monad, which
 * `eth_estimateGas` at "latest" does not include; the keeper and the market maker add the same allowance, RUNBOOK §1).
 * Without it an order or deposit that lands first in a block runs out of gas and reverts. Live chains only: anvil's
 * "pending" estimate already includes the touch. Token approvals never touch funding and keep the tight limit.
 */
export const TOUCH_ALLOWANCE_GAS = 70_000n;
export const touchAllowance = (chainId: number, localChainId: number, functionName: string): bigint =>
  chainId === localChainId || functionName === "approve" ? 0n : TOUCH_ALLOWANCE_GAS;
