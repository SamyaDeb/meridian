// A Live built from real stores with fake runtime deps (no network): tests push values in directly.
import meridian10143 from "../../../deployments/10143.json";
import perplJson from "../../../deployments/perpl.json";
import type { PublicClient } from "viem";
import { buildAppConfig } from "../config/appConfig";
import { BlockSource, type Timer } from "../live/blockStore";
import type { Live } from "../live/live";
import { MeridianMarketReader } from "../live/meridianMarket";
import { PerplMarket } from "../live/perplMarket";

export function manualTimer(start = 1_000_000): Timer & { tick(ms: number): void } {
  let now = start;
  return { now: () => now, set: () => 0, clear: () => undefined, tick: (ms) => void (now += ms) };
}

export function fakeLive() {
  const config = buildAppConfig({ appEnv: "development", rpcUrl: undefined, wsUrl: undefined, meridianDeployments: { 10143: meridian10143 }, perplJson });
  if (config.meridian.status !== "deployed" || config.perpl.status !== "deployed") throw new Error("fixture deployments");
  const timer = manualTimer();
  const blocks = new BlockSource({ getBlockNumber: () => new Promise(() => undefined), timer });
  const client = { multicall: async () => [] } as unknown as PublicClient;
  const meridian = new MeridianMarketReader({ client, clearingHouse: config.meridian.deployment.contracts.ClearingHouse, orderBook: config.meridian.deployment.contracts.OrderBook });
  const noWs = () => ({ send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null });
  const perpl = new PerplMarket({ deployment: config.perpl.deployment, wsUrl: "wss://test.invalid", fetch: async () => ({ status: 503, text: async () => "", headers: { get: () => null } }), wsFactory: noWs });
  const live: Live = { config, client, blocks, meridian, perpl, resume: () => undefined, pause: () => undefined };
  return { live, timer, blocks, meridian, perpl };
}
