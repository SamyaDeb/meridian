"use client";
import { createContext, useContext } from "react";
import type { MeridianDataSource } from "./source";
import { createMockSource } from "./mock/source";

const DataSourceContext = createContext<MeridianDataSource>(createMockSource());
export const DataSourceProvider = DataSourceContext.Provider;
export const useDataSource = (): MeridianDataSource => useContext(DataSourceContext);

/** CR-017: the data source of each non-default swap market (today: "perpl", chain mode only). */
const SwapSourcesContext = createContext<ReadonlyMap<string, MeridianDataSource>>(new Map());
export const SwapSourcesProvider = SwapSourcesContext.Provider;
/** The source serving `swap` ("meridian" = the selected market's source), or undefined when this build has none. */
export function useSwapSource(swap: "meridian" | "perpl"): MeridianDataSource | undefined {
  const ds = useDataSource();
  const others = useContext(SwapSourcesContext);
  return swap === "meridian" ? ds : others.get(swap);
}
