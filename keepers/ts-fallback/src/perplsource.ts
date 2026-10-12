// PS (CR-017): keeper decisions for a FundingSwapMarket that settles on Perpl's funding through PerplFundingSource.
// Pure, bigint only; unit-tested in test/perplsource.test.ts with recorded views (docs/PERPL_SWAPS.md §Units).
import type { Address } from "viem";

/** One entry of the record's `swapMarkets` list (AddSwapMarket.s.sol `_newEntry`). */
export interface SwapMarketRecord {
  symbol: string;
  fundingSource: string;
  perplPerpId: number;
  perplExchange: Address;
  PerplFundingSource: Address;
  FundingSwapMarket: Address;
  SwapOrderBook: Address;
  tickSizeWad: string;
  lotSizeWad: string;
  maturity: number;
  startBlock: number;
  deployed: boolean;
}

/**
 * The swap market for `key` (case-insensitive symbol, e.g. "MON-FUNDING-PERPL", or "perpl" = the first entry whose
 * fundingSource is "perpl"). Refuses an entry without `deployed: true` (a dry-run record is never served).
 */
export function resolveSwapMarket(rec: { swapMarkets?: SwapMarketRecord[] }, key: string, path = "deployments"): SwapMarketRecord {
  const k = key.toUpperCase();
  const all = rec.swapMarkets ?? [];
  const m = all.find((s) => s.symbol.toUpperCase() === k) ?? (k === "PERPL" ? all.find((s) => s.fundingSource === "perpl") : undefined);
  if (m === undefined) {
    const known = all.map((s) => s.symbol).join(", ") || "none";
    throw new Error(`SWAP_MARKET=${key}: not in ${path} swapMarkets (${known})`);
  }
  if (m.deployed !== true) throw new Error(`${path}: swap market ${m.symbol} is not deployed (deployed: ${String(m.deployed)})`);
  if (m.fundingSource !== "perpl") throw new Error(`${path}: swap market ${m.symbol} funding source is ${m.fundingSource}, not perpl`);
  return m;
}

export interface PerplPokeInput {
  /** Perpl `getFundingSumAtBlock(perp, head).fundingEventBlock` */
  perplFeb: bigint;
  /** PerplFundingSource `latestObservation().blockNumber` (its last snapshotted feb) */
  sourceFeb: bigint;
  /** a poke of ours is in flight, or landed and its effect not yet read */
  pending: boolean;
  /** current block */
  block: bigint;
  /** block of our last poke attempt that reverted (e.g. StalePerplPrice); −1 = none */
  lastFailedBlock: bigint;
  /** blocks to wait after a reverted poke before retrying (Perpl's oracle updates every few seconds) */
  retryAfterBlocks: bigint;
}

/**
 * Poke exactly when Perpl has applied a funding event the source has not snapshotted, none of ours is pending, and we
 * are not inside the back-off after a reverted attempt. Each poke catches up any number of missed events in O(1), so
 * there is never a reason to poke twice for one event.
 */
export function shouldPokePerpl(i: PerplPokeInput): boolean {
  if (i.pending || i.perplFeb <= i.sourceFeb) return false;
  return i.lastFailedBlock < 0n || i.block - i.lastFailedBlock >= i.retryAfterBlocks;
}

/** Monad bills the gas limit: limit = estimate × 1.2 (CONTRIBUTING.md §7), rounded up. */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
}

/** Blocks the source lags Perpl (0 when current). The watcher pages above 2 intervals (VerifyDeployment check). */
export function sourceLagBlocks(perplFeb: bigint, sourceFeb: bigint): bigint {
  return perplFeb > sourceFeb ? perplFeb - sourceFeb : 0n;
}
