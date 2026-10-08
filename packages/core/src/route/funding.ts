// Funding per day on both venues, signed: + = the position PAYS, − = it receives. bigint only.
// Meridian (MATH_SPEC §1.1–§1.4): funding accrues per BLOCK, ΔF = r·I·blockTimeMs/1000 per block (blockTimeMs is the
//   contract's fundingParams().blockTimeMs). Real-world blocks per day come from the MEASURED block time (block.number
//   advance over the client's wall clock, never block timestamps: 1 s resolution vs ~300 ms blocks, §1.1).
// Perpl (MFI.md §2, api-docs types.md FundingEvent): `rate` micros of notional per funding interval (from config,
//   mainnet 2,580 s, MOBILE_PLAN §0.5); positive ⇒ longs pay.
import { SECONDS_PER_YEAR, WAD, divCeil, divTrunc } from "../util/fixed";

/** Measured block cadence: `blocks` advanced over `elapsedMs` of the client's clock. */
export type BlockCadence = { blocks: bigint; elapsedMs: bigint };

/** Two head observations (block number + local receive time) → cadence. Needs ≥ 1 block and > 0 ms. */
export function measureCadence(a: { block: bigint; atMs: number }, b: { block: bigint; atMs: number }): BlockCadence | undefined {
  const blocks = b.block - a.block;
  const elapsedMs = BigInt(Math.round(b.atMs - a.atMs));
  return blocks > 0n && elapsedMs > 0n ? { blocks, elapsedMs } : undefined;
}

/** Bounded rolling cadence: keep the oldest and newest observation of the last `windowMs` (default 60 s). */
export class CadenceMeter {
  private obs: { block: bigint; atMs: number }[] = [];
  constructor(private readonly windowMs = 60_000) {}
  observe(block: bigint, atMs: number): void {
    const last = this.obs.at(-1);
    if (last && block <= last.block) return; // a lagging RPC is not progress (app/src/lib/blocks.ts rule)
    this.obs.push({ block, atMs });
    this.obs = this.obs.filter((o) => o.atMs >= atMs - this.windowMs).slice(-256);
  }
  cadence(): BlockCadence | undefined {
    const a = this.obs[0];
    const b = this.obs.at(-1);
    return a && b ? measureCadence(a, b) : undefined;
  }
}

export type MeridianFundingInput = {
  /** signed size, base WAD (+ long) */
  sizeWad: bigint;
  /** previewFundingState().rate: per (contract) second, WAD, signed */
  ratePerSecWad: bigint;
  /** index price, WAD */
  indexWad: bigint;
  /** fundingParams().blockTimeMs */
  paramBlockTimeMs: bigint;
  cadence: BlockCadence;
};

/**
 * MATH_SPEC §1.2 / §1.4 at the measured cadence: owed per day = q · r·I·blockTimeMs/1000 per block · blocks per day / 1e18
 * = q·r·I·blockTimeMs·86,400,000·blocks / (1e18·1e18·1000·elapsedMs). One division, rounds up (owed ↑, received ↓, §1.4).
 */
export function meridianFundingPerDayWad(i: MeridianFundingInput): bigint {
  return divCeil(i.sizeWad * i.ratePerSecWad * i.indexWad * i.paramBlockTimeMs * 86_400_000n * i.cadence.blocks, WAD * WAD * 1000n * i.cadence.elapsedMs);
}

/**
 * Meridian's rate as an APR of REAL time: r·YEAR scaled by contract-seconds per real second (blockTimeMs·blocks/elapsed).
 * Equals rateToAprWad(r) when the chain runs at its nominal block time. Rounds neutral (a reference value).
 */
export const meridianEffectiveAprWad = (ratePerSecWad: bigint, paramBlockTimeMs: bigint, c: BlockCadence): bigint => divTrunc(ratePerSecWad * SECONDS_PER_YEAR * paramBlockTimeMs * c.blocks, c.elapsedMs);

export type PerplFundingInput = { sizeWad: bigint; markWad: bigint; rateMicros: bigint | number; fundingIntervalSec: bigint | number };

/** owed per day = q·mark·rate·1e-6 · 86,400 / interval_sec (quote WAD). One division, rounds up (owed ↑, received ↓). */
export function perplFundingPerDayWad(i: PerplFundingInput): bigint {
  const iv = BigInt(i.fundingIntervalSec);
  if (iv <= 0n) throw new RangeError("funding interval must be positive");
  return divCeil(i.sizeWad * i.markWad * BigInt(i.rateMicros) * 10n ** 12n * 86_400n, WAD * WAD * iv);
}

/** Funding per day on a notional (quote WAD) at an APR, signed by the side: + long pays at a positive APR. Rounds up. */
export const fundingPerDayFromAprWad = (side: "long" | "short", notionalWad: bigint, aprWad: bigint): bigint => divCeil((side === "long" ? 1n : -1n) * notionalWad * aprWad * 86_400n, WAD * SECONDS_PER_YEAR);
