"use client";
import { createContext, useContext } from "react";
import type { PulseDataSource } from "./source";
import { createMockSource } from "./mock/source";

const DataSourceContext = createContext<PulseDataSource>(createMockSource());
export const DataSourceProvider = DataSourceContext.Provider;
export const useDataSource = (): PulseDataSource => useContext(DataSourceContext);
