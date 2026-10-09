// The ticket's per-venue inputs, assembled from the live stores (no number typed in): Meridian book + riskParams
// (N2 reader), Perpl book + market-config fees (N2 feed), positions / collateral (accounts reader), wallet balances
// (N4b wallet feed: Meridian's AUSD and Perpl's collateral token, which differ on testnet), Perpl readiness (N4).
import { feeForTier, perplFeeWad, perplLotWad } from "@meridian/core/perpl";
import { WAD } from "@meridian/core/util";
import type { AppConfig } from "../../../config/appConfig";
import type { MeridianMarketState } from "../../../live/meridianMarket";
import type { PerplMarketState } from "../../../live/perplMarket";
import { dpOfTick } from "../../../ui";
import { balanceTokens, type BalanceState } from "../../../wallet/balances";
import type { AccountsState } from "../data/accounts";
import type { VenueInput } from "./quote";

/** Wallet balance (WAD) of the token that funds `venue`; undefined until read. */
export function walletWadFor(cfg: Pick<AppConfig, "meridian" | "perpl">, b: BalanceState | undefined, venue: "meridian" | "perpl"): bigint | undefined {
  if (!b) return undefined;
  const specs = balanceTokens(cfg);
  const addr = venue === "meridian" ? (cfg.meridian.status === "deployed" ? cfg.meridian.deployment.contracts.AUSD : undefined) : cfg.perpl.status === "deployed" ? cfg.perpl.deployment.collateralToken : undefined;
  if (!addr) return undefined;
  const i = specs.findIndex((t) => t.address.toLowerCase() === addr.toLowerCase());
  const t = i >= 0 ? b.tokens[i] : undefined;
  if (!t || t.amount === undefined || t.decimals === undefined) return undefined;
  return t.amount * 10n ** BigInt(18 - t.decimals);
}

/** 1 / imr as a number of × (display + eligibility); undefined until riskParams arrive. */
export const maxLevOfImr = (imrWad: bigint | undefined): number | undefined => (imrWad && imrWad > 0n ? Number((WAD * 100n) / imrWad) / 100 : undefined);

export function meridianInput(side: "long" | "short", m: MeridianMarketState | undefined, acc: AccountsState | undefined, walletWad: bigint | undefined): VenueInput {
  const pos = acc?.meridian && acc.meridian.sizeWad !== 0n ? { sizeWad: acc.meridian.sizeWad, entryWad: acc.meridian.entryWad } : undefined;
  return {
    venue: "meridian",
    label: "Meridian",
    levels: m?.bookKnown ? (side === "long" ? m.asks : m.bids) : undefined,
    takerFeeWad: m?.takerFeeWad,
    stepWad: m?.lotSizeWad,
    priceStepWad: m?.tickSizeWad,
    priceDp: dpOfTick(m?.tickSizeWad),
    maxLeverage: maxLevOfImr(m?.imrWad),
    ready: true,
    freeCollateralWad: acc?.meridian?.freeWad,
    walletWad,
    liq: m?.mmrWad !== undefined && m.imrWad !== undefined ? { kind: "meridian", mmrWad: m.mmrWad, imrWad: m.imrWad, collateralWad: acc?.meridian?.collateralWad ?? 0n, position: pos } : undefined,
  };
}

export function perplInput(side: "long" | "short", p: PerplMarketState | undefined, acc: AccountsState | undefined, walletWad: bigint | undefined, o: { ready: boolean; feeTier: number | undefined; collateralDecimals: number }): VenueInput {
  const takerMicros = p?.takerMicros;
  const fee = takerMicros !== undefined ? perplFeeWad(feeForTier({ makerMicros: 0, takerMicros, ...(p?.takerTiers ? { takerTiers: [...p.takerTiers] } : {}) }, o.feeTier ?? 0, false)) : undefined;
  const pd = p?.priceDecimals;
  const margins = acc?.perplMargins;
  return {
    venue: "perpl",
    label: "Perpl",
    levels: p?.bookKnown ? (side === "long" ? p.asks : p.bids) : undefined,
    takerFeeWad: fee,
    stepWad: p ? perplLotWad(p.sizeDecimals) : undefined,
    priceStepWad: pd !== undefined ? 10n ** BigInt(18 - pd) : undefined,
    priceDp: pd ?? 4,
    // getMarginFractions init hdths is a leverage divisor (core liqPerpl header): 300 ⇒ 3×
    maxLeverage: margins ? Number(margins.initHdths) / 100 : undefined,
    ready: o.ready,
    freeCollateralWad: acc?.perpl ? acc.perpl.freeWad : acc?.perpl === null ? 0n : undefined,
    walletWad,
    liq: margins && pd !== undefined && p ? { kind: "perpl", maintHdths: margins.maintHdths, priceDecimals: pd, sizeDecimals: p.sizeDecimals, collateralDecimals: o.collateralDecimals } : undefined,
  };
}
