"use client";
import { createContext, useContext } from "react";
import type { MeridianDataSource } from "./source";
import { createMockSource } from "./mock/source";

const DataSourceContext = createContext<MeridianDataSource>(createMockSource());
export const DataSourceProvider = DataSourceContext.Provider;
export const useDataSource = (): MeridianDataSource => useContext(DataSourceContext);
