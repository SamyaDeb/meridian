// Trade for the unlocked wallet (mounted under the auth gate): the chart feed (Perpl candles + live last price per block),
// the account reader (positions + collateral on both venues, per block while a screen that shows them is focused:
// Trade, Home; `focus` counts them so a tab switch's focus/blur order can't switch reads off) and the
// executor (one order at a time, persisted, resumed on launch). Built from the app config + core; nothing invented.
import { clearingHouseAbi } from "@meridian/core/meridian";
import { createPerplClient, httpTransport } from "@meridian/core/perpl";
import { useFocusEffect } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useAccountAddress, useAuthController, useAuthStatus } from "../../auth/AuthProvider";
import { secureKv } from "../../auth/secureKv";
import { useLive } from "../../live/LiveProvider";
import { Store } from "../../live/store";
import { usePerpl as usePerplVenue } from "../../venues/perpl/PerplProvider";
import { useActivity } from "../activity/ActivityProvider";
import { rnFetch, sleep } from "../../venues/perpl/runtime";
import { walletClientFor } from "../../wallet/client";
import { ChartFeed } from "./chart/feed";
import { AccountsReader, mapMeridian } from "./data/accounts";
import { ensureMeridianCollateral } from "./exec/collateral";
import { TradeExecutor, type VenueRun } from "./exec/executor";
import { createMeridianLeg } from "./exec/meridianLeg";
import { createPerplLeg } from "./exec/perplLeg";
import { recordStore, type TradeRecord } from "./exec/record";
import type { TradeSession } from "./exec/runTrade";

export type TradeKit = { chart: ChartFeed | undefined; accounts: AccountsReader | undefined; executor: TradeExecutor | undefined; focus: Store<number> };

const TradeContext = createContext<TradeKit>({ chart: undefined, accounts: undefined, executor: undefined, focus: new Store(0) });

export function TradeProvider({ children, kit: injected }: { children: ReactNode; kit?: TradeKit }) {
  const live = useLive();
  const auth = useAuthController();
  const status = useAuthStatus();
  const { address } = useAccountAddress();
  const venue = usePerplVenue();
  const activity = useActivity();
  const cfg = live.config;
  const [focus] = useState(() => new Store(0));

  const chart = useMemo(() => {
    if (injected) return injected.chart;
    if (cfg.perpl.status !== "deployed") return undefined;
    const d = cfg.perpl.deployment;
    const meta = d.markets[d.monMarketId]!;
    return new ChartFeed({ client: createPerplClient({ transport: httpTransport(d.apiUrl, rnFetch) }), marketId: meta.id, priceDecimals: meta.priceDecimals });
  }, [cfg, injected]);

  const accounts = useMemo(() => {
    if (injected) return injected.accounts;
    if (status !== "unlocked" || !address || !live.client) return undefined;
    const p = cfg.perpl.status === "deployed" ? cfg.perpl.deployment : undefined;
    const meta = p ? p.markets[p.monMarketId] : undefined;
    return new AccountsReader({
      client: live.client,
      address,
      meridian: cfg.meridian.status === "deployed" ? { clearingHouse: cfg.meridian.deployment.contracts.ClearingHouse } : undefined,
      perpl: p && meta ? { exchange: p.exchange, perpId: BigInt(meta.id), priceDecimals: meta.priceDecimals, lotDecimals: meta.sizeDecimals, collateralDecimals: p.collateralDecimals } : undefined,
    });
  }, [injected, status, address, live.client, cfg]);

  const executor = useMemo(() => {
    if (injected) return injected.executor;
    if (status !== "unlocked" || !address || !live.client) return undefined;
    const pub = live.client;
    const venueRun = (session: TradeSession, rec: TradeRecord): VenueRun => {
      if (rec.meta.venue === "perpl") {
        if (!venue || cfg.perpl.status !== "deployed") throw new Error("Perpl isn't available right now");
        const meta = cfg.perpl.deployment.markets[venue.marketId]!;
        const leg = createPerplLeg({
          trading: () => venue.socket.client,
          rest: () => venue.onboarding.signedRest(),
          market: { id: meta.id, priceDecimals: meta.priceDecimals, sizeDecimals: meta.sizeDecimals },
          leverage100: rec.meta.leverage100,
          head: () => venue.socket.client?.state.head?.block ?? live.perpl?.store.get().headBlock,
          saveRqFloor: (rq) => session.patchMeta({ perpl: rq !== undefined ? { rqFloor: rq } : {} }),
        });
        return {
          legs: leg.legs,
          findSentPerpl: leg.findSent,
          facts: async (r) => {
            const f = r.state.phase === "DONE" ? await leg.fills(r.state.result!.filledWad, sleep) : { orderId: leg.orderId(), feeCns: undefined, fillBlock: undefined };
            return { ...(f.orderId !== undefined ? { orderId: f.orderId } : {}), ...(f.feeCns !== undefined ? { feeCns: f.feeCns } : {}), ...(f.fillBlock !== undefined ? { fillBlock: BigInt(f.fillBlock) } : {}) };
          },
        };
      }
      if (cfg.meridian.status !== "deployed") throw new Error("Meridian isn't deployed on this chain");
      const c = cfg.meridian.deployment.contracts;
      const m = live.meridian?.store.get();
      if (!m?.tickSizeWad || !m.lotSizeWad) throw new Error("Meridian's market is still loading. Try again in a moment.");
      const leg = createMeridianLeg({
        pub,
        wallet: () => walletClientFor(auth.account(), cfg),
        orderBook: c.OrderBook,
        tickSizeWad: m.tickSizeWad,
        lotSizeWad: m.lotSizeWad,
        saveRaw: (raw, nonce) => session.patchMeta({ meridian: { ...session.rec.meta.meridian, raw, nonce } }),
        loadRaw: () => session.rec.meta.meridian ?? {},
      });
      const freeNow = async () => mapMeridian((await pub.readContract({ address: c.ClearingHouse, abi: clearingHouseAbi, functionName: "getAccount", args: [address] })) as never).freeWad;
      const need = rec.meta.meridian?.needWad ?? 0n;
      return {
        legs: leg.legs,
        prepareCollateral: async () => {
          if (need === 0n || (await freeNow()) >= need) return; // nothing to deposit: no passkey prompt
          await auth.withFreshSession((account) => ensureMeridianCollateral({ pub, wallet: walletClientFor(account, cfg), token: c.AUSD, clearingHouse: c.ClearingHouse, needWad: need, freeNow }));
        },
        facts: async (r) => ({ ...(r.state.leg.ref ? { txHash: r.state.leg.ref as `0x${string}` } : {}), ...(leg.receipt() ? { receiptBlock: leg.receipt()!.blockNumber } : {}) }),
      };
    };
    return new TradeExecutor({
      store: recordStore(secureKv, cfg.chainId, address),
      venueRun,
      head: () => live.blocks?.store.get().block,
      explorerBase: cfg.chain.blockExplorers?.default.url,
      collateralDecimals: cfg.perpl.status === "deployed" ? cfg.perpl.deployment.collateralDecimals : 6,
      sleep,
      onReceipt: (r) => void activity.log?.add({ atMs: Date.now(), block: live.blocks?.store.get().block, receipt: r }),
      afterTrade: () => {
        accounts?.invalidate();
        void venue?.refresh().catch(() => undefined);
        void activity.feed?.refresh();
      },
    });
  }, [injected, status, address, live, cfg, venue, auth, accounts, activity]);

  // per block: the chart's live point; the account reader only while Trade is on screen
  useEffect(() => {
    const blocks = live.blocks;
    if (!blocks) return;
    let last: bigint | undefined;
    return blocks.store.subscribe(() => {
      const b = blocks.store.get().block;
      if (b === undefined || b === last) return;
      last = b;
      chart?.onLive(live.perpl?.store.get().lastWad);
      if (focus.get() > 0) void accounts?.onBlock(b);
    });
  }, [live, chart, accounts, focus]);

  // candles on mount and on every foreground; an open trade from before a kill resumes once the venue is there
  useEffect(() => {
    chart?.refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") chart?.refresh();
    });
    return () => sub.remove();
  }, [chart]);

  useEffect(() => {
    void executor?.resume();
  }, [executor]);

  const kit = useMemo<TradeKit>(() => injected ?? { chart, accounts, executor, focus }, [injected, chart, accounts, executor, focus]);
  return <TradeContext.Provider value={kit}>{children}</TradeContext.Provider>;
}

export const useTrade = (): TradeKit => useContext(TradeContext);

/** Count `focus` up while the calling component is held (a screen, or an always-on reader like in-app alerts). */
export function holdAccountReads(focus: Store<number>): () => void {
  focus.set(focus.get() + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    focus.set(Math.max(0, focus.get() - 1));
  };
}

/** Positions + collateral are read per block while the calling screen is on top. */
export function useAccountReadsWhileFocused(): void {
  const { focus } = useTrade();
  useFocusEffect(useCallback(() => holdAccountReads(focus), [focus]));
}
