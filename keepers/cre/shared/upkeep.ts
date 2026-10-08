// W2 upkeep decisions (funding poke, vault rebalance). Pure; unit-tested in test/upkeep.test.ts.

/**
 * Poke updateFunding() when the market's last FundingUpdated is at least `maxGapBlocks` behind the head. The TS keeper
 * keeps the gap ≤ 20 blocks; the CRE backstop fires only when that keeper has fallen behind (default 40 blocks ≈ 12 s).
 */
export function fundingStale(headBlock: bigint, lastUpdateBlock: bigint, maxGapBlocks: bigint): boolean {
  return headBlock >= lastUpdateBlock && headBlock - lastUpdateBlock >= maxGapBlocks;
}

/** IMeridianVault.RebalanceReason (enum order in the frozen interface). */
export const REBALANCE_REASONS = ["None", "Deploy", "DeltaDrift", "MarginLow", "ExitHedge", "EnterHedge", "Withdraw", "SkewCap"] as const;

export function rebalanceReasonName(reason: number): string {
  return REBALANCE_REASONS[reason] ?? `Unknown(${reason})`;
}
