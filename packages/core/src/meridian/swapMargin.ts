// Funding-swap margin, value and fee, ported 1:1 from contracts/src/libs/SwapMarginLib.sol, SwapMathLib.value and
// FundingSwapMarket._fee / _mm (MATH_SPEC §6.3–§6.5) with the same rounding, so the app can size the collateral a Lock
// needs BEFORE sending (the contract checks equity_after ≥ IM_after on a fill that grows |q|). All WAD:
//   q size (signed), K fixed-APR notional (+= Δq·A/1e18 per fill), markApr / A APR, I index price, capApr = rateCap·YEAR,
//   τ seconds to maturity. Requirements round UP; the value V rounds DOWN (both against the user).
import { SECONDS_PER_YEAR, WAD, abs, divCeil, divFloor } from "../util/fixed";

const YEAR = SECONDS_PER_YEAR;
/** SwapMarginLib.PRICE_SHOCK (MATH_SPEC §6.4 constant). */
export const SWAP_PRICE_SHOCK = 3n * 10n ** 17n;

const mulWadUp = (a: bigint, b: bigint) => divCeil(a * b, WAD);
const mulDivUp = (a: bigint, b: bigint, d: bigint) => divCeil(a * b, d);

export type SwapObs = { markAprWad: bigint; indexWad: bigint; capAprWad: bigint; tauSec: bigint };
export type SwapParamsLite = { liqHorizonSec: bigint; aprMoveBuffer: bigint; imMultiplier: bigint; takerFeeApr: bigint };

/** MM (SwapMarginLib.maintenanceMargin via FundingSwapMarket._mm), rounds up. τ = 0 ⇒ 0; q = 0 ⇒ the price-shock term only when K > 0. */
export function swapMaintenanceMargin(q: bigint, k: bigint, o: SwapObs, p: Pick<SwapParamsLite, "liqHorizonSec" | "aprMoveBuffer">): bigint {
  if (o.tauSec === 0n) return 0n;
  const priceShock = (qq: bigint, mark: bigint) => mulWadUp(mulDivUp(mulWadUp(divCeil(abs(qq * mark - k * WAD), WAD), o.indexWad), o.tauSec, YEAR), SWAP_PRICE_SHOCK);
  if (q === 0n) return k <= 0n ? 0n : priceShock(0n, 0n);
  const horizon = p.liqHorizonSec < o.tauSec ? p.liqHorizonSec : o.tauSec;
  const worstRate = mulWadUp(o.indexWad, mulWadUp(abs(q), o.capAprWad) + abs(k));
  const worst = mulDivUp(worstRate, horizon, YEAR);
  const aprShock = mulDivUp(mulWadUp(mulWadUp(abs(q), o.indexWad), p.aprMoveBuffer), o.tauSec, YEAR);
  return worst + aprShock + priceShock(q, o.markAprWad);
}

/** IM = MM · imMultiplier, rounds up. */
export const swapInitialMargin = (mm: bigint, imMultiplier: bigint): bigint => mulWadUp(mm, imMultiplier);

/** V = (⌊q·markApr/1e18⌋ − K)·I·τ/(1e18·YEAR), rounds down (SwapMathLib.value). */
export function swapValueWad(q: bigint, k: bigint, o: Pick<SwapObs, "markAprWad" | "indexWad" | "tauSec">): bigint {
  const stream = divFloor(q * o.markAprWad, WAD) - k;
  return divFloor(stream * o.indexWad * o.tauSec, WAD * YEAR);
}

/** Taker fee |Δq|·I·feeApr·τ/YEAR, rounds up (FundingSwapMarket._fee, feeApr ≥ 0). */
export const swapTakerFeeWad = (sizeWad: bigint, o: Pick<SwapObs, "indexWad" | "tauSec">, takerFeeApr: bigint): bigint => mulDivUp(mulWadUp(mulWadUp(sizeWad, o.indexWad), takerFeeApr), o.tauSec, YEAR);

export type LockNeedInput = {
  /** the account's swap position now (getPosition: size, fixedAprNotional) and its settled collateral (getAccount.collateral + accruedNet) */
  q0: bigint;
  k0: bigint;
  collateralWad: bigint;
  /** the fill: signed size (+ buy = receive floating) at the WORST APR the order accepts (limit price − 1) */
  dq: bigint;
  worstAprWad: bigint;
  obs: SwapObs;
  params: SwapParamsLite;
};

/**
 * Collateral to ADD on the swap market so the fill passes the contract's check `collateral − fee + V(after) ≥ IM(after)`,
 * evaluated at the worst APR the order accepts (K_after = K0 + Δq·A/1e18, truncating as the contract does). Rounds up;
 * 0 when the account already covers it.
 */
export function swapLockNeedWad(i: LockNeedInput): bigint {
  const q = i.q0 + i.dq;
  const k = i.k0 + (i.dq * i.worstAprWad) / WAD; // SwapMathLib.kDelta: truncates toward 0
  const fee = swapTakerFeeWad(abs(i.dq), i.obs, i.params.takerFeeApr);
  const im = swapInitialMargin(swapMaintenanceMargin(q, k, i.obs, i.params), i.params.imMultiplier);
  const v = swapValueWad(q, k, i.obs);
  const need = im + fee - v - i.collateralWad;
  return need > 0n ? need : 0n;
}
