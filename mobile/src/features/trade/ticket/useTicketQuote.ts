// Live quote for the open ticket: recomputed on every block (the stores tick) and on input changes (debounced 150 ms by
// the sheet). Only the sheet subscribes, so the screen behind it doesn't re-render per block.
import { useMemo } from "react";
import { useLive } from "../../../live/LiveProvider";
import { useMeridian, usePerpl } from "../../../live/hooks";
import type { MeridianMarketState } from "../../../live/meridianMarket";
import type { PerplMarketState } from "../../../live/perplMarket";
import { Store, useStore } from "../../../live/store";
import { useWalletFeed } from "../../wallet/WalletFeedProvider";
import type { WalletFeed } from "../../../wallet/feed";
import type { OnboardingState } from "../../../venues/perpl/onboarding";
import type { TradingSocketState } from "../../../venues/perpl/tradingSocket";
import { usePerplOnboarding, usePerplSocket } from "../../../venues/perpl/PerplProvider";
import type { AccountsState } from "../data/accounts";
import { useTrade } from "../TradeProvider";
import { quoteTicket, type Pick, type TicketQuote } from "./quote";
import { meridianInput, perplInput, walletWadFor } from "./venues";

const selM = (s: MeridianMarketState | undefined) => s;
const selP = (s: PerplMarketState | undefined) => s;
const selAcc = (s: AccountsState) => s;
const selBal = (f: WalletFeed) => f.balances;
const selReady = (s: OnboardingState | undefined) => s?.view?.ready ?? false;
const selFt = (s: TradingSocketState | undefined) => s?.account?.ft;
const selSock = (s: TradingSocketState | undefined) => s?.status === "ready";
const NO_ACC = new Store<AccountsState>({ atBlock: undefined, meridian: undefined, perpl: undefined, perplMargins: undefined, error: undefined });

/** The last quote shown (the route modal reads it). */
export const lastQuoteStore = new Store<TicketQuote | undefined>(undefined);

export function useTicketQuote(i: { side: "long" | "short"; amountWad: bigint | undefined; leverage: number; slippageBps: bigint; pick: Pick }): TicketQuote {
  const cfg = useLive().config;
  const m = useMeridian(selM);
  const p = usePerpl(selP);
  const acc = useStore(useTrade().accounts?.store ?? NO_ACC, selAcc);
  const bal = useWalletFeed(selBal);
  const ready = usePerplOnboarding(selReady);
  const sockReady = usePerplSocket(selSock);
  const ft = usePerplSocket(selFt);
  const collateralDecimals = cfg.perpl.status === "deployed" ? cfg.perpl.deployment.collateralDecimals : 6;
  return useMemo(() => {
    const venues = [
      ...(cfg.meridian.status === "deployed" ? [meridianInput(i.side, m, acc, walletWadFor(cfg, bal, "meridian"))] : []),
      ...(cfg.perpl.status === "deployed" ? [perplInput(i.side, p, acc, walletWadFor(cfg, bal, "perpl"), { ready: ready && sockReady, feeTier: ft, collateralDecimals })] : []),
    ];
    const q = quoteTicket({ ...i, venues });
    lastQuoteStore.set(q);
    return q;
  }, [cfg, m, p, acc, bal, ready, sockReady, ft, collateralDecimals, i.side, i.amountWad, i.leverage, i.slippageBps, i.pick]); // eslint-disable-line react-hooks/exhaustive-deps
}
