// Trade for the unlocked wallet (mounted under the auth gate): the chart feed (Perpl candles + live last price per block),
// the account reader (positions + collateral on both venues, per block while a screen that shows them is focused:
// Trade, Home; `focus` counts them so a tab switch's focus/blur order can't switch reads off) and the
// executor (one order at a time, persisted, resumed on launch). Built from the app config + core; nothing invented.
import { clearingHouseAbi } from "@meridian/core/meridian";
import { createPerplClient, httpTransport } from "@meridian/core/perpl";
import { useFocusEffect } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LegAdapter } from "@meridian/core/exec";
import type { Venue } from "@meridian/core/route";
import type { Hex } from "viem";
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
import { MeridianTradesReader } from "./data/trades";
import { CloseAllExecutor, closeAllStore } from "./exec/closeAll";
import { OrderLock } from "./exec/orderLock";
import { ensureMeridianCollateral } from "./exec/collateral";
import type { Receipt } from "./exec/receipt";
import { TradeExecutor, type VenueRun } from "./exec/executor";
import { createMeridianLeg } from "./exec/meridianLeg";
import { createPerplLeg } from "./exec/perplLeg";
import { recordStore, type TradeRecord } from "./exec/record";
import type { TradeSession } from "./exec/runTrade";

export type TradeKit = { chart: ChartFeed | undefined; accounts: AccountsReader | undefined; executor: TradeExecutor | undefined; closeAll?: CloseAllExecutor | undefined; focus: Store<number>; trades?: MeridianTradesReader | undefined; orderLock?: OrderLock | undefined };

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
  // one order at a time across the Trade executor, Close all and Earn (EarnProvider registers through the kit)
  const [orderLock] = useState(() => new OrderLock());

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

  // Meridian's public trades (Pro → Trades): read per block only while that tab is on screen
  const trades = useMemo(() => {
    if (injected) return injected.trades;
    if (cfg.meridian.status !== "deployed" || !live.client) return undefined;
    return new MeridianTradesReader({ client: live.client, orderBook: cfg.meridian.deployment.contracts.OrderBook });
  }, [injected, cfg, live.client]);

  // the venue legs, shared by the single-order executor and Close all (each run passes its own persistence hooks)
  const legKit = useMemo(() => {
    if (injected || status !== "unlocked" || !address || !live.client) return undefined;
    const pub = live.client;
    const perpl = (saveRqFloor: (rq: number | undefined) => Promise<void>, leverage100: number) => {
      if (!venue || cfg.perpl.status !== "deployed") throw new Error("Perpl isn't available right now");
      const meta = cfg.perpl.deployment.markets[venue.marketId]!;
      return createPerplLeg({
        trading: () => venue.socket.client,
        rest: () => venue.onboarding.signedRest(),
        market: { id: meta.id, priceDecimals: meta.priceDecimals, sizeDecimals: meta.sizeDecimals },
        leverage100,
        head: () => venue.socket.client?.state.head?.block ?? live.perpl?.store.get().headBlock,
        saveRqFloor,
      });
    };
    const meridian = (saveRaw: (raw: Hex, nonce: number) => Promise<void>, loadRaw: () => { raw?: Hex; nonce?: number }) => {
      if (cfg.meridian.status !== "deployed") throw new Error("Meridian isn't deployed on this chain");
      const m = live.meridian?.store.get();
      if (!m?.tickSizeWad || !m.lotSizeWad) throw new Error("Meridian's market is still loading. Try again in a moment.");
      return createMeridianLeg({ pub, wallet: () => walletClientFor(auth.account(), cfg), orderBook: cfg.meridian.deployment.contracts.OrderBook, tickSizeWad: m.tickSizeWad, lotSizeWad: m.lotSizeWad, saveRaw, loadRaw });
    };
    return { pub, perpl, meridian };
  }, [injected, status, address, live, cfg, venue, auth]);

  const afterTrade = useCallback(() => {
    accounts?.invalidate();
    void venue?.refresh().catch(() => undefined);
    void activity.feed?.refresh();
  }, [accounts, venue, activity]);
  const logReceipt = useCallback((r: Receipt) => void activity.log?.add({ atMs: Date.now(), block: live.blocks?.store.get().block, receipt: r }), [activity, live]);

  const executor = useMemo(() => {
    if (injected) return injected.executor;
    if (!legKit || !address) return undefined;
    const { pub } = legKit;
    const venueRun = (session: TradeSession, rec: TradeRecord): VenueRun => {
      if (rec.meta.venue === "perpl") {
        const leg = legKit.perpl((rq) => session.patchMeta({ perpl: rq !== undefined ? { rqFloor: rq } : {} }), rec.meta.leverage100);
        return {
          legs: leg.legs,
          findSentPerpl: leg.findSent,
          facts: async (r) => {
            const f = r.state.phase === "DONE" ? await leg.fills(r.state.result!.filledWad, sleep) : { orderId: leg.orderId(), feeCns: undefined, fillBlock: undefined };
            return { ...(f.orderId !== undefined ? { orderId: f.orderId } : {}), ...(f.feeCns !== undefined ? { feeCns: f.feeCns } : {}), ...(f.fillBlock !== undefined ? { fillBlock: BigInt(f.fillBlock) } : {}) };
          },
        };
      }
      const leg = legKit.meridian(
        (raw, nonce) => session.patchMeta({ meridian: { ...session.rec.meta.meridian, raw, nonce } }),
        () => session.rec.meta.meridian ?? {},
      );
      if (cfg.meridian.status !== "deployed") throw new Error("Meridian isn't deployed on this chain");
      const c = cfg.meridian.deployment.contracts;
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
      blocked: () => orderLock.blocked("single"),
      onReceipt: logReceipt,
      afterTrade,
    });
  }, [injected, legKit, address, live, cfg, auth, logReceipt, afterTrade, orderLock]);

  const closeAll = useMemo(() => {
    if (injected) return injected.closeAll;
    if (!legKit || !address) return undefined;
    return new CloseAllExecutor({
      store: closeAllStore(secureKv, cfg.chainId, address),
      legs: (h) => {
        const p = legKit.perpl(h.saveRqFloor, 100);
        const m = legKit.meridian(h.saveRaw, h.loadRaw);
        const pick = (venue: Venue | "swap"): LegAdapter => {
          if (venue === "swap") throw new Error("A close has no swap leg");
          return venue === "perpl" ? p.legs : m.legs;
        };
        return {
          legs: { prepare: (leg) => pick(leg.venue).prepare(leg), send: (leg, ref) => pick(leg.venue).send(leg, ref), confirm: (leg, ref) => pick(leg.venue).confirm(leg, ref) },
          findSentPerpl: p.findSent,
          perplOrderId: p.orderId,
        };
      },
      blocked: () => orderLock.blocked("closeAll"),
      explorerBase: cfg.chain.blockExplorers?.default.url,
      sleep,
      onReceipt: logReceipt,
      afterTrade,
    });
  }, [injected, legKit, address, cfg, logReceipt, afterTrade, orderLock]);

  // registered during render, so they're in place before EarnProvider's (child) effects register Earn and resume
  orderLock.register("single", { busy: () => executor?.busy ?? false, resume: () => executor?.resume() ?? Promise.resolve() });
  orderLock.register("closeAll", { busy: () => closeAll?.busy ?? false, resume: () => closeAll?.resume() ?? Promise.resolve() });

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
      if (focus.get() > 0) {
        void accounts?.onBlock(b);
        void trades?.onBlock(b);
      }
    });
  }, [live, chart, accounts, trades, focus]);

  // candles on mount and on every foreground; an open trade from before a kill resumes once the venue is there
  useEffect(() => {
    chart?.refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") chart?.refresh();
    });
    return () => sub.remove();
  }, [chart]);

  // resume after a kill, one at a time, awaited: an open single trade, then Close all, then Earn
  useEffect(() => {
    void orderLock.resume();
  }, [executor, closeAll, orderLock]);

  const kit = useMemo<TradeKit>(() => injected ?? { chart, accounts, executor, closeAll, focus, trades, orderLock }, [injected, chart, accounts, executor, closeAll, focus, trades, orderLock]);
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
