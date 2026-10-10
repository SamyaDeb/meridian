// Hands a confirmed order (ticket or close) to the executor with the record meta it needs: venue statics from the live
// readers / deployments (price decimals, size step, taker fee), the wallet, the summary the user accepted.
import { perplFeeWad, perplLotWad } from "@meridian/core/perpl";
import type { Venue } from "@meridian/core/route";
import { useCallback } from "react";
import { useAccountAddress } from "../../auth/AuthProvider";
import { useLive } from "../../live/LiveProvider";
import { dpOfTick } from "../../ui";
import type { Receipt } from "./exec/receipt";
import { useTrade } from "./TradeProvider";

export type StartOrder = {
  venue: Venue;
  side: "buy" | "sell";
  sizeWad: bigint;
  reduceOnly: boolean;
  limitPriceWad: bigint;
  expectedAvgWad?: bigint;
  summary: string;
  /** Meridian: margin + fee the account must hold (the rest is deposited with a permit first) */
  needWad?: bigint;
  /** ×100 (Perpl OrderSpec.lv) */
  leverage100: number;
};

export function useStartOrder(): (o: StartOrder) => Promise<Receipt | undefined> {
  const { executor } = useTrade();
  const live = useLive();
  const { address } = useAccountAddress();
  return useCallback(
    async (o: StartOrder) => {
      if (!executor || !address) throw new Error("Unlock to trade");
      const cfg = live.config;
      let priceDp = 4;
      let stepWad = 1n;
      let takerFeeWad = 0n;
      if (o.venue === "perpl") {
        if (cfg.perpl.status !== "deployed") throw new Error("Perpl isn't configured on this chain");
        const meta = cfg.perpl.deployment.markets[cfg.perpl.deployment.monMarketId]!;
        priceDp = meta.priceDecimals;
        stepWad = perplLotWad(meta.sizeDecimals);
        const micros = live.perpl?.store.get().takerMicros;
        takerFeeWad = micros !== undefined ? perplFeeWad(micros) : 0n;
      } else {
        const m = live.meridian?.store.get();
        if (!m?.lotSizeWad || !m.tickSizeWad) throw new Error("Meridian's market is still loading. Try again in a moment.");
        priceDp = dpOfTick(m.tickSizeWad);
        stepWad = m.lotSizeWad;
        takerFeeWad = m.takerFeeWad ?? 0n;
      }
      return executor.start(
        { venue: o.venue, side: o.side, sizeWad: o.sizeWad, reduceOnly: o.reduceOnly, limitPriceWad: o.limitPriceWad, ...(o.expectedAvgWad !== undefined ? { expectedAvgWad: o.expectedAvgWad } : {}) },
        {
          chainId: cfg.chainId,
          address,
          venue: o.venue,
          side: o.side === "buy" ? (o.reduceOnly ? "short" : "long") : o.reduceOnly ? "long" : "short",
          summary: o.summary,
          priceDp,
          stepWad,
          takerFeeWad,
          leverage100: o.leverage100,
          ...(o.venue === "meridian" && o.needWad !== undefined ? { meridian: { needWad: o.needWad } } : {}),
        },
      );
    },
    [executor, address, live],
  );
}
