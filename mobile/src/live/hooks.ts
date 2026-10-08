// Leaf-level subscriptions: each hook selects one value so a block tick re-renders only what changed.
import { meridianEffectiveAprWad, spreadAprWad, type BlockCadence, type Realized } from "@meridian/core/route";
import type { Liveness } from "@meridian/core/meridian";
import { useMemo } from "react";
import type { BlockState } from "./blockStore";
import { useLive } from "./LiveProvider";
import type { MeridianMarketState } from "./meridianMarket";
import { networkStore, type NetworkState } from "./network";
import type { PerplMarketState } from "./perplMarket";
import { Store, useStore } from "./store";

const EMPTY_BLOCKS = new Store<BlockState | undefined>(undefined);
const EMPTY_MERIDIAN = new Store<MeridianMarketState | undefined>(undefined);
const EMPTY_PERPL = new Store<PerplMarketState | undefined>(undefined);

const selBlock = (s: BlockState | undefined) => s?.block;
const selLiveness = (s: BlockState | undefined): Liveness => s?.liveness ?? "waiting";
const selCadence = (s: BlockState | undefined) => s?.cadence;
const selSource = (s: BlockState | undefined) => s?.source;
const selBackoff = (s: BlockState | undefined) => s?.backoffMs ?? 0;

function useBlocksStore(): Store<BlockState | undefined> {
  return (useLive().blocks?.store as Store<BlockState | undefined> | undefined) ?? EMPTY_BLOCKS;
}

export const useBlockNumber = (): bigint | undefined => useStore(useBlocksStore(), selBlock);
export const useLiveness = (): Liveness => useStore(useBlocksStore(), selLiveness);
export const useCadence = (): BlockCadence | undefined => useStore(useBlocksStore(), selCadence);
export const useBlockSource = (): "poll" | "ws" | undefined => useStore(useBlocksStore(), selSource);
export const useBlockBackoff = (): number => useStore(useBlocksStore(), selBackoff);

export function useMeridian<S>(select: (s: MeridianMarketState | undefined) => S): S {
  return useStore((useLive().meridian?.store as Store<MeridianMarketState | undefined> | undefined) ?? EMPTY_MERIDIAN, select);
}

export function usePerpl<S>(select: (s: PerplMarketState | undefined) => S): S {
  return useStore((useLive().perpl?.store as Store<PerplMarketState | undefined> | undefined) ?? EMPTY_PERPL, select);
}

export function useNetwork<S>(select: (s: NetworkState) => S): S {
  return useStore(networkStore, select);
}

const selRate = (s: MeridianMarketState | undefined) => s?.rateWad;
const selBlockTime = (s: MeridianMarketState | undefined) => s?.paramBlockTimeMs;
const selPerplApr = (s: PerplMarketState | undefined) => s?.aprNowWad;
const selRealized = (s: PerplMarketState | undefined) => s?.realized;

export type FundingSpread = {
  /** Meridian's current funding rate as an APR of real time at the measured block cadence */
  meridianAprWad: bigint | undefined;
  /** Perpl's rate in force, annualized */
  perplAprWad: bigint | undefined;
  /** Meridian − Perpl */
  spreadAprWad: bigint | undefined;
  /** Perpl realized over the last 8 h */
  perplRealized: Realized | undefined;
};

/** Funding on both venues + the spread, all through core math (bigint WAD). Undefined parts = unknown ("—"). */
export function useFundingSpread(): FundingSpread {
  const rate = useMeridian(selRate);
  const bt = useMeridian(selBlockTime);
  const cadence = useCadence();
  const perplApr = usePerpl(selPerplApr);
  const perplRealized = usePerpl(selRealized);
  return useMemo(() => {
    const m = rate !== undefined && bt !== undefined && cadence ? meridianEffectiveAprWad(rate, bt, cadence) : undefined;
    return { meridianAprWad: m, perplAprWad: perplApr, spreadAprWad: m !== undefined && perplApr !== undefined ? spreadAprWad(m, perplApr) : undefined, perplRealized };
  }, [rate, bt, cadence, perplApr, perplRealized]);
}
