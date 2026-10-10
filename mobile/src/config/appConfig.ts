// The app's whole environment behind one typed function (MOBILE_PLAN N2 §2). When P1 `packages/config` lands
// (LAUNCH_PLAN §3.1), only this module changes. Pure `buildAppConfig` (tested) + `getAppConfig` (reads Expo/env).
//
// Sources: chain ids CONTRIBUTING §7 / viem `monad`, `monadTestnet`; packages + rpIds MOBILE_PLAN §5 (N0); deployments
// via @meridian/core readers (refuse `deployed: false` / a missing 143.json); Perpl WS bases: perpl-api skill §1
// (github.com/PerplFoundation/api-docs). RPC URLs only from EXPO_PUBLIC_* env (never committed, never logged).
import { tryReadMeridianDeployment, tryReadPerplDeployment, type DeploymentRead, type MeridianDeployment, type PerplDeployment } from "@meridian/core/meridian";
import { monad, monadTestnet, type Chain } from "viem/chains";

export type AppEnv = "development" | "staging" | "production";
export const APP_ENVS: readonly AppEnv[] = ["development", "staging", "production"];

export type RpcConfig = {
  http: string;
  ws: string | undefined;
  /** viem's public RPC (development only): rate-limited, the UI shows a "public RPC" badge */
  isPublic: boolean;
};

export type AppConfig = {
  env: AppEnv;
  chainId: 143 | 10143;
  chain: Chain;
  /** passkey relying party (N3) */
  rpId: string;
  androidPackage: string;
  /** undefined ⇒ no RPC configured for this build: chain reads are off and the UI says so */
  rpc: RpcConfig | undefined;
  meridian: DeploymentRead<MeridianDeployment>;
  perpl: DeploymentRead<PerplDeployment>;
  /** Perpl WS origin (market-data at /ws/v1/market-data); undefined when Perpl isn't configured on the chain */
  perplWsUrl: string | undefined;
  /** both venues readable: the app can show live numbers */
  live: boolean;
  /** why `live` is false, in plain words */
  notLiveReason: string | undefined;
  /** Envio GraphQL endpoint for Meridian history (EXPO_PUBLIC_INDEXER_URL); undefined ⇒ Activity lists this app's own trades + Perpl only */
  indexerUrl: string | undefined;
  /** the web terminal ("Open full terminal"); undefined when this env's web app isn't known */
  webUrl: string | undefined;
  /** where a forced update sends people (the APK install link); undefined ⇒ "Ask the Meridian team for the new version" */
  installUrl: string | undefined;
};

const IDENTITY: Record<AppEnv, { chainId: 143 | 10143; rpId: string; androidPackage: string }> = {
  development: { chainId: 10143, rpId: "meridian-testnet.vercel.app", androidPackage: "xyz.meridianfi.app.staging" },
  staging: { chainId: 10143, rpId: "meridian-testnet.vercel.app", androidPackage: "xyz.meridianfi.app.staging" },
  production: { chainId: 143, rpId: "meridianfi.vercel.app", androidPackage: "xyz.meridianfi.app" },
};

/**
 * Web terminal per env. Staging: the existing testnet Vercel project (MOBILE_PLAN §5, 8 Oct: `/` 307 → /trade).
 * > VERIFY: the production web URL (meridianfi.vercel.app is a placeholder that only claims the rpId host, §5) — set it
 * here on mainnet day (N9); until then the button is hidden on production builds.
 * EXPO_PUBLIC_APP_ENV (eas.json, next to APP_ENV) is inlined by Metro, so a production bundle folds this to the
 * production entry and doesn't even contain the testnet web URL (check:release asserts it).
 */
const TESTNET_WEB = process.env.EXPO_PUBLIC_APP_ENV === "production" ? undefined : "https://meridian-testnet.vercel.app";
const WEB: Record<AppEnv, string | undefined> = { development: TESTNET_WEB, staging: TESTNET_WEB, production: undefined };

/**
 * APK install link per env (the forced-update screen's button). > VERIFY: the EAS internal-distribution links are made at
 * N8 (owner, `eas build -p android --profile preview|production`); set them here then. Until then the screen asks people
 * to contact the team.
 */
const INSTALL: Record<AppEnv, string | undefined> = { development: undefined, staging: undefined, production: undefined };

const CHAINS: Record<143 | 10143, Chain> = { 143: monad, 10143: monadTestnet };

/** perpl-api skill §1 (api-docs): market-data + trading sockets live on these origins. */
const PERPL_WS: Record<143 | 10143, string> = { 143: "wss://app.perpl.xyz", 10143: "wss://testnet.perpl.xyz" };

export function parseAppEnv(v: unknown): AppEnv {
  if (v === undefined || v === null || v === "") return "development";
  if (typeof v === "string" && (APP_ENVS as readonly string[]).includes(v)) return v as AppEnv;
  throw new Error(`APP_ENV must be one of ${APP_ENVS.join(", ")}`);
}

const clean = (v: string | undefined): string | undefined => (v && v.trim().length > 0 ? v.trim() : undefined);

export type AppConfigInput = {
  appEnv: unknown;
  rpcUrl: string | undefined;
  wsUrl: string | undefined;
  /** parsed deployments/<chainId>.json by chain id; a missing key = the file doesn't exist yet */
  meridianDeployments: Partial<Record<number, unknown>>;
  /** parsed deployments/perpl.json */
  perplJson: unknown;
  indexerUrl?: string | undefined;
};

export function buildAppConfig(i: AppConfigInput): AppConfig {
  const env = parseAppEnv(i.appEnv);
  const id = IDENTITY[env];
  const chain = CHAINS[id.chainId];
  const http = clean(i.rpcUrl);
  if (http !== undefined && !/^https:\/\//.test(http)) throw new Error("EXPO_PUBLIC_MONAD_RPC_URL must be an https:// URL");
  const ws = clean(i.wsUrl);
  if (ws !== undefined && !/^wss:\/\//.test(ws)) throw new Error("EXPO_PUBLIC_MONAD_WS_URL must be a wss:// URL");
  const indexerUrl = clean(i.indexerUrl);
  if (indexerUrl !== undefined && !/^https:\/\//.test(indexerUrl)) throw new Error("EXPO_PUBLIC_INDEXER_URL must be an https:// URL");

  let rpc: RpcConfig | undefined;
  if (http !== undefined) rpc = { http, ws, isPublic: false };
  else if (env === "development") {
    const pub = chain.rpcUrls.default.http[0];
    rpc = pub ? { http: pub, ws: undefined, isPublic: true } : undefined;
  }

  const meridian = tryReadMeridianDeployment(i.meridianDeployments[id.chainId], id.chainId);
  const perpl = tryReadPerplDeployment(i.perplJson, id.chainId);

  const reasons: string[] = [];
  if (meridian.status !== "deployed") reasons.push(id.chainId === 143 ? "Meridian isn't live on Monad mainnet yet" : `Meridian isn't deployed on chain ${id.chainId}`);
  if (perpl.status !== "deployed") reasons.push(`Perpl isn't configured on chain ${id.chainId}`);
  if (!rpc) reasons.push("No RPC is configured for this build");

  return {
    env,
    chainId: id.chainId,
    chain,
    rpId: id.rpId,
    androidPackage: id.androidPackage,
    rpc,
    meridian,
    perpl,
    perplWsUrl: perpl.status === "deployed" ? PERPL_WS[id.chainId] : undefined,
    live: reasons.length === 0,
    notLiveReason: reasons.length ? reasons.join(" · ") : undefined,
    indexerUrl,
    webUrl: WEB[env],
    installUrl: INSTALL[env],
  };
}
