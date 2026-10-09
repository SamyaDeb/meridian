// Earn for the unlocked wallet (mounted under TradeProvider: it shares the account reader and, for the one-tap close of a
// leftover, the Trade executor): the two-leg executor (N5 venue legs keyed per leg, one fresh-prompt collateral top-up,
// persisted runs resumed on unlock) and the 24 h gap history. Built from the app config + core; nothing invented.
import type { LegAdapter } from "@meridian/core/exec";
import { clearingHouseAbi } from "@meridian/core/meridian";
import { createPerplClient, httpTransport, perplExchangeAbi } from "@meridian/core/perpl";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useAccountAddress, useAuthController, useAuthStatus } from "../../auth/AuthProvider";
import { secureKv } from "../../auth/secureKv";
import { useLive } from "../../live/LiveProvider";
import { PERPL_TX_ABI, usePerpl as usePerplVenue } from "../../venues/perpl/PerplProvider";
import { rnFetch, sleep } from "../../venues/perpl/runtime";
import { walletClientFor } from "../../wallet/client";
import { sendTx } from "../../wallet/sendTx";
import { mapMeridian } from "../trade/data/accounts";
import { ensureMeridianCollateral } from "../trade/exec/collateral";
import { createMeridianLeg } from "../trade/exec/meridianLeg";
import { createPerplLeg } from "../trade/exec/perplLeg";
import { useTrade } from "../trade/TradeProvider";
import { ensureEarnCollateral, perplTopUp } from "./collateral";
import { EarnExecutor, type LegFactory } from "./executor";
import { GapHistory } from "./history";
import { earnRecordStore, positionStore, type EarnMeta } from "./record";

export type EarnKit = { executor: EarnExecutor | undefined; history: GapHistory | undefined };
const EarnContext = createContext<EarnKit>({ executor: undefined, history: undefined });

/** __DEV__ only: the forced-failure wrapper (release bundles drop the require; check:release greps for its marker). */
const devWrap: ((legs: LegAdapter, meta: EarnMeta) => LegAdapter) | undefined = __DEV__
  ? (legs, meta) => (meta.devFailMeridian ? (require("./devFail") as typeof import("./devFail")).withForcedMeridianFailure(legs) : legs)
  : undefined;

export function EarnProvider({ children, kit: injected }: { children: ReactNode; kit?: EarnKit }) {
  const live = useLive();
  const auth = useAuthController();
  const status = useAuthStatus();
  const { address } = useAccountAddress();
  const venue = usePerplVenue();
  const { accounts } = useTrade();
  const cfg = live.config;

  const executor = useMemo(() => {
    if (injected) return injected.executor;
    if (status !== "unlocked" || !address || !live.client || cfg.meridian.status !== "deployed" || cfg.perpl.status !== "deployed") return undefined;
    const pub = live.client;
    const c = cfg.meridian.deployment.contracts;
    const pd = cfg.perpl.deployment;
    const meta = pd.markets[pd.monMarketId]!;
    const scale = 10n ** BigInt(18 - pd.collateralDecimals);

    const freeMeridian = async () => mapMeridian((await pub.readContract({ address: c.ClearingHouse, abi: clearingHouseAbi, functionName: "getAccount", args: [address] })) as never).freeWad;
    const freePerpl = async () => {
      try {
        const a = (await pub.readContract({ address: pd.exchange, abi: perplExchangeAbi, functionName: "getAccountByAddr", args: [address] })) as { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint };
        const free = a.balanceCNS - a.lockedBalanceCNS;
        return a.accountId === 0n || free <= 0n ? 0n : free * scale;
      } catch {
        return 0n; // the view reverts for a wallet with no exchange account
      }
    };

    const legFor: LegFactory = (leg, io) => {
      if (leg.venue === "perpl") {
        if (!venue) throw new Error("Perpl isn't connected yet. Stay on this screen a moment and try again.");
        const l = createPerplLeg({
          trading: () => venue.socket.client,
          rest: () => venue.onboarding.signedRest(),
          market: { id: meta.id, priceDecimals: meta.priceDecimals, sizeDecimals: meta.sizeDecimals },
          leverage100: io.meta.leverage100,
          head: () => venue.socket.client?.state.head?.block ?? live.perpl?.store.get().headBlock,
          saveRqFloor: (rq) => io.patch(rq !== undefined ? { rqFloor: rq } : {}),
        });
        // after an unlock / relaunch the trading socket connects a moment later: a hedge or an unwind waits for it
        // (up to ~20 s) instead of failing straight into the retry / manual path
        const connected = async () => {
          for (let i = 0; i < 40 && venue.socket.client?.state.account === undefined; i++) await sleep(500);
        };
        return {
          legs: { ...l.legs, prepare: async (x) => (await connected(), l.legs.prepare(x)) },
          findSent: async (floor, side, ro) => (await connected(), l.findSent(floor, side, ro)),
          orderId: l.orderId,
        };
      }
      if (leg.venue !== "meridian") throw new Error("Lock isn't available in this build");
      const m = live.meridian?.store.get();
      if (!m?.tickSizeWad || !m.lotSizeWad) throw new Error("Meridian's market is still loading. Try again in a moment.");
      const l = createMeridianLeg({ pub, wallet: () => walletClientFor(auth.account(), cfg), orderBook: c.OrderBook, tickSizeWad: m.tickSizeWad, lotSizeWad: m.lotSizeWad, saveRaw: (raw, nonce) => io.patch({ raw, nonce }), loadRaw: () => io.note() });
      return { legs: l.legs };
    };

    return new EarnExecutor({
      chainId: cfg.chainId,
      address,
      runs: earnRecordStore(secureKv, cfg.chainId, address),
      positions: positionStore(secureKv, cfg.chainId, address),
      legFor,
      ensureCollateral: async (perplWad, meridianWad) => {
        await ensureEarnCollateral(
          {
            freeMeridian,
            freePerpl,
            withFreshSession: (fn) => auth.withFreshSession(fn),
            depositMeridian: (account, needWad) => ensureMeridianCollateral({ pub, wallet: walletClientFor(account, cfg), token: c.AUSD, clearingHouse: c.ClearingHouse, needWad, freeNow: freeMeridian }),
            depositPerpl: (account, amountCns) => perplTopUp({ pub, send: (req) => sendTx(pub, walletClientFor(account, cfg), req, { abi: PERPL_TX_ABI }), token: pd.collateralToken, exchange: pd.exchange, owner: address, amountCns }),
            perplCollateralDecimals: pd.collateralDecimals,
          },
          perplWad,
          meridianWad,
        );
      },
      head: () => live.blocks?.store.get().block,
      explorerBase: cfg.chain.blockExplorers?.default.url,
      sleep,
      ...(devWrap ? { wrapLegs: devWrap } : {}),
      afterRun: () => {
        accounts?.invalidate();
        void venue?.refresh().catch(() => undefined);
      },
    });
  }, [injected, status, address, live, cfg, venue, auth, accounts]);

  const history = useMemo(() => {
    if (injected) return injected.history;
    if (cfg.perpl.status !== "deployed" || cfg.meridian.status !== "deployed" || !live.client) return undefined;
    const pub = live.client;
    const pd = cfg.perpl.deployment;
    const meta = pd.markets[pd.monMarketId]!;
    const client = createPerplClient({ transport: httpTransport(pd.apiUrl, rnFetch) });
    const ch = cfg.meridian.deployment.contracts.ClearingHouse;
    return new GapHistory({
      perplFunding: (from, to) => client.getFunding(meta.id, from, to),
      meridianRateAt: async (blockNumber) => ((await pub.readContract({ address: ch, abi: clearingHouseAbi, functionName: "previewFundingState", blockNumber })) as { rate: bigint }).rate,
      perplIntervalSec: meta.fundingIntervalSec,
    });
  }, [injected, cfg, live.client]);

  // a run from before an app kill continues once the venues are there (Perpl's trading socket can lag the unlock)
  useEffect(() => {
    void executor?.resume();
  }, [executor]);

  const kit = useMemo<EarnKit>(() => injected ?? { executor, history }, [injected, executor, history]);
  return <EarnContext.Provider value={kit}>{children}</EarnContext.Provider>;
}

export const useEarn = (): EarnKit => useContext(EarnContext);
