// Earn's live inputs, assembled from the stores (no number typed in): both funding APRs through core (useFundingSpread),
// both books + fees + steps (N2/N5 readers), free collateral + positions (shared account reader), the wallet token that
// funds each venue (N4b feed), Perpl readiness (N4). Recomputed per block and on input changes.
import { feeForTier, perplFeeWad, perplLotWad } from "@meridian/core/perpl";
import { useMemo } from "react";
import { useLive } from "../../live/LiveProvider";
import { useFundingSpread, useMeridian, usePerpl } from "../../live/hooks";
import type { MeridianMarketState } from "../../live/meridianMarket";
import type { PerplMarketState } from "../../live/perplMarket";
import { Store, useStore } from "../../live/store";
import { dpOfTick } from "../../ui";
import type { OnboardingState } from "../../venues/perpl/onboarding";
import { usePerplOnboarding, usePerplSocket } from "../../venues/perpl/PerplProvider";
import type { TradingSocketState } from "../../venues/perpl/tradingSocket";
import type { WalletFeed } from "../../wallet/feed";
import type { AccountsState } from "../trade/data/accounts";
import { maxLevOfImr, walletWadFor } from "../trade/ticket/venues";
import { useTrade } from "../trade/TradeProvider";
import { useWalletFeed } from "../wallet/WalletFeedProvider";
import type { SwapState } from "./data/swap";
import { useEarn } from "./EarnProvider";
import { earnAvailableWad, quoteEarn, type EarnLockInput, type EarnQuote, type EarnVenueInput } from "./plan";

const NO_SWAP = new Store<SwapState | undefined>(undefined);
const selSwap = (s: SwapState | undefined) => s;

const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;
const selAcc = (s: AccountsState) => s;
const selBal = (f: WalletFeed) => f.balances;
const selReady = (s: OnboardingState | undefined) => s?.view?.ready ?? false;
const selFt = (s: TradingSocketState | undefined) => s?.account?.ft;
const selSock = (s: TradingSocketState | undefined) => s?.status === "ready";
export const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });

export type EarnInputs = { meridian: EarnVenueInput; perpl: EarnVenueInput; availableWad: bigint | undefined; accounts: AccountsState; perplPriceDp: number; meridianPriceDp: number; swap: SwapState | undefined; indexWad: bigint | undefined };

export function useEarnInputs(): EarnInputs {
  const cfg = useLive().config;
  const f = useFundingSpread();
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const acc = useStore(useTrade().accounts?.store ?? NO_ACC, selAcc);
  const bal = useWalletFeed(selBal);
  const ready = usePerplOnboarding(selReady);
  const sockReady = usePerplSocket(selSock);
  const ft = usePerplSocket(selFt);
  const sw = useStore(useEarn().swap?.store ?? NO_SWAP, selSwap);
  return useMemo(() => {
    const takerMicros = p?.takerMicros;
    const perplFee = takerMicros !== undefined ? perplFeeWad(feeForTier({ makerMicros: 0, takerMicros, ...(p?.takerTiers ? { takerTiers: [...p.takerTiers] } : {}) }, ft ?? 0, false)) : undefined;
    const pd = p?.priceDecimals;
    const meridian: EarnVenueInput = {
      aprWad: f.meridianAprWad,
      takerFeeWad: m?.takerFeeWad,
      stepWad: m?.lotSizeWad,
      priceStepWad: m?.tickSizeWad,
      priceDp: dpOfTick(m?.tickSizeWad),
      bids: m?.bookKnown ? m.bids : undefined,
      asks: m?.bookKnown ? m.asks : undefined,
      markWad: m?.markWad,
      freeWad: acc.meridian?.freeWad,
      walletWad: walletWadFor(cfg, bal, "meridian"),
      ready: true,
      ...(m?.imrWad !== undefined ? { imrWad: m.imrWad } : {}),
      ...(maxLevOfImr(m?.imrWad) !== undefined ? { maxLeverage: maxLevOfImr(m?.imrWad)! } : {}),
    };
    const perpl: EarnVenueInput = {
      aprWad: f.perplAprWad,
      takerFeeWad: perplFee,
      stepWad: p ? perplLotWad(p.sizeDecimals) : undefined,
      priceStepWad: pd !== undefined ? 10n ** BigInt(18 - pd) : undefined,
      priceDp: pd ?? 4,
      bids: p?.bookKnown ? p.bids : undefined,
      asks: p?.bookKnown ? p.asks : undefined,
      markWad: p?.markWad,
      freeWad: acc.perpl ? acc.perpl.freeWad : acc.perpl === null ? 0n : undefined,
      walletWad: walletWadFor(cfg, bal, "perpl"),
      ready: ready && sockReady,
      // getMarginFractions init hdths is a leverage divisor (core liqPerpl header): 300 ⇒ 3×
      ...(acc.perplMargins ? { maxLeverage: Number(acc.perplMargins.initHdths) / 100 } : {}),
    };
    return { meridian, perpl, availableWad: earnAvailableWad(meridian, perpl), accounts: acc, perplPriceDp: perpl.priceDp, meridianPriceDp: meridian.priceDp, swap: sw && (sw.atBlock !== undefined || sw.params) ? sw : undefined, indexWad: m?.indexWad };
  }, [cfg, f, m, p, acc, bal, ready, sockReady, ft, sw]);
}

/** The Lock input from the swap reader + the oracle index (FundingSwapMarket._observe uses ClearingHouse.indexPrice). */
export function lockInputOf(inputs: EarnInputs, on: boolean): EarnLockInput | undefined {
  const s = inputs.swap;
  if (!s) return undefined;
  const obs = s.markAprWad !== undefined && s.tauSec !== undefined && s.capAprWad !== undefined && inputs.indexWad !== undefined ? { markAprWad: s.markAprWad, indexWad: inputs.indexWad, capAprWad: s.capAprWad, tauSec: s.tauSec } : undefined;
  return { on, bids: s.bookKnown ? s.bids : undefined, asks: s.bookKnown ? s.asks : undefined, tickSizeWad: s.tickSizeWad, lotSizeWad: s.lotSizeWad, params: s.params, obs, matured: s.matured, maturity: s.maturity, account: s.account };
}

export function useEarnQuote(amountWad: bigint | undefined, inputs: EarnInputs, lockOn = false): EarnQuote {
  return useMemo(() => {
    const lock = lockInputOf(inputs, lockOn);
    return quoteEarn({ amountWad, meridian: inputs.meridian, perpl: inputs.perpl, ...(lock ? { lock } : {}) });
  }, [amountWad, inputs, lockOn]);
}
