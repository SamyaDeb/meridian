// Runtime wiring of buildAppConfig: APP_ENV from the Expo config `extra` (set per EAS profile), RPC from EXPO_PUBLIC_*
// (inlined by Metro at build time, so each must be read as a literal `process.env.EXPO_PUBLIC_…`).
import Constants from "expo-constants";
import meridian10143 from "../../../deployments/10143.json";
import perplJson from "../../../deployments/perpl.json";
import { buildAppConfig, type AppConfig } from "./appConfig";

export * from "./appConfig";

let cached: AppConfig | undefined;

export function getAppConfig(): AppConfig {
  cached ??= buildAppConfig({
    appEnv: (Constants.expoConfig?.extra as { appEnv?: unknown } | undefined)?.appEnv,
    rpcUrl: process.env.EXPO_PUBLIC_MONAD_RPC_URL,
    wsUrl: process.env.EXPO_PUBLIC_MONAD_WS_URL,
    // deployments/143.json doesn't exist until mainnet day (N9): add `143: meridian143` then.
    meridianDeployments: { 10143: meridian10143 },
    perplJson,
  });
  return cached;
}

/** Build profile + version for Settings. */
export function buildInfo(): { version: string; env: string } {
  return { version: Constants.expoConfig?.version ?? "—", env: getAppConfig().env };
}
