// Builds the app's live layer from the config: block source → (per new block) Meridian reader + Perpl sample.
// Pure wiring with injectable runtime deps so tests can build it with fakes.
import type { FetchLike, WsFactory, WsLike } from "@meridian/core/util";
import type { PublicClient } from "viem";
import type { AppConfig } from "../config/appConfig";
import { BlockSource, type BlockSourceDeps } from "./blockStore";
import { publicClientFor, wsHeadSubscriber } from "./clients";
import { MeridianMarketReader } from "./meridianMarket";
import { PerplMarket } from "./perplMarket";

export type Live = {
  config: AppConfig;
  client: PublicClient | undefined;
  blocks: BlockSource | undefined;
  meridian: MeridianMarketReader | undefined;
  perpl: PerplMarket | undefined;
  /** start everything (app launch, foreground): immediate refetch */
  resume(): void;
  /** stop polling + sockets (background) */
  pause(): void;
};

export type LiveDeps = {
  client?: PublicClient;
  blockDeps?: Partial<BlockSourceDeps>;
  fetch?: FetchLike;
  wsFactory?: WsFactory;
};

// RN's global fetch / WebSocket satisfy core's injected interfaces (packages/core/src/util/runtime.ts).
const rnFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
const rnWs: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export function createLive(config: AppConfig, deps: LiveDeps = {}): Live {
  const client = deps.client ?? (config.rpc ? publicClientFor(config.chain, config.rpc) : undefined);

  const blocks = client
    ? new BlockSource({
        getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
        ...(config.rpc?.ws ? { subscribeHeads: wsHeadSubscriber(config.chain, config.rpc.ws) } : {}),
        ...deps.blockDeps,
      })
    : undefined;

  const meridian =
    client && config.meridian.status === "deployed"
      ? new MeridianMarketReader({ client, clearingHouse: config.meridian.deployment.contracts.ClearingHouse, orderBook: config.meridian.deployment.contracts.OrderBook })
      : undefined;

  const perpl =
    config.perpl.status === "deployed" && config.perplWsUrl
      ? new PerplMarket({ deployment: config.perpl.deployment, wsUrl: config.perplWsUrl, fetch: deps.fetch ?? rnFetch, wsFactory: deps.wsFactory ?? rnWs })
      : undefined;

  // per new head: one Meridian read (skipped while one is in flight) + a Perpl sample, so both venues tick together
  let lastBlock: bigint | undefined;
  blocks?.store.subscribe(() => {
    const b = blocks.store.get().block;
    if (b === undefined || b === lastBlock) return;
    lastBlock = b;
    void meridian?.onBlock(b);
    perpl?.sample();
  });

  let running = false;
  return {
    config,
    client,
    blocks,
    meridian,
    perpl,
    resume() {
      if (running) return;
      running = true;
      blocks?.start();
      perpl?.start(); // opens the socket and re-seeds from REST
    },
    pause() {
      if (!running) return;
      running = false;
      blocks?.stop();
      perpl?.stop();
    },
  };
}
