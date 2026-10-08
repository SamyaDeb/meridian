// Perpl for one unlocked wallet: the onboarding detector/actions + the app's single trading socket, kept in step.
// Re-detects on unlock and on every foreground; the socket runs only while READY, unlocked and in the foreground.
import { createPerplClient, httpTransport, matchMarket, type PerplClient, type TradingConfig } from "@meridian/core/perpl";
import type { PerplDeployment } from "@meridian/core/meridian";
import type { FetchLike, RandomBytes, WsFactory } from "@meridian/core/util";
import { PerplOnboarding, type OnboardingDeps } from "./onboarding";
import { TradingSocketManager } from "./tradingSocket";

export type VenueDeps = OnboardingDeps & {
  deployment: PerplDeployment;
  wsUrl: string;
  wsFactory: WsFactory;
  fetchFn: FetchLike;
  random: RandomBytes;
  /** injected for tests: the public client used for /v1/pub/context */
  client?: PerplClient;
  /** injected for tests */
  socket?: TradingSocketManager;
};

export class PerplVenue {
  readonly onboarding: PerplOnboarding;
  readonly socket: TradingSocketManager;
  readonly marketId: number;
  private ttlBlocks: number | undefined;
  private client: PerplClient;
  private disposed = false;

  constructor(private d: VenueDeps) {
    this.onboarding = new PerplOnboarding(d);
    this.marketId = d.deployment.monMarketId;
    this.client = d.client ?? createPerplClient({ transport: httpTransport(d.deployment.apiUrl, d.fetchFn) });
    this.socket = d.socket ?? new TradingSocketManager(() => this.tradingConfig());
  }

  /** core TradingConfig for the stored token + the session's key; undefined unless both exist and ttl is known */
  tradingConfig(): TradingConfig | undefined {
    const key = this.d.auth.perplKey();
    const token = this.onboarding.token();
    const acc = this.onboarding.store.get().view?.apiAccount?.id;
    if (!key || !token || this.ttlBlocks === undefined) return undefined;
    return {
      apiUrl: this.d.deployment.apiUrl,
      wsUrl: this.d.wsUrl,
      chainId: this.d.chainId,
      apiKey: token,
      secret: key.signer,
      marketId: this.marketId,
      orderTtlBlocks: this.ttlBlocks,
      ...(acc !== undefined ? { accountId: acc } : {}),
      factory: this.d.wsFactory,
      fetchFn: this.d.fetchFn,
      random: this.d.random,
    };
  }

  /** market.order_ttl_blocks from /v1/pub/context (never hard-coded; websocket.md "Last execution block") */
  private async loadTtl(): Promise<void> {
    if (this.ttlBlocks !== undefined) return;
    const ctx = await this.client.getContext();
    const m = ctx.markets.find((x) => x.id === this.marketId) ?? matchMarket(ctx.markets, "MON");
    if (!m || m.order_ttl_blocks === undefined) throw new Error(`Perpl context has no order_ttl_blocks for market ${this.marketId}`);
    this.ttlBlocks = m.order_ttl_blocks;
  }

  /** Detect onboarding, then open or close the trading socket to match. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const v = await this.onboarding.refresh();
    if (this.disposed) return;
    if (v.ready) {
      try {
        await this.loadTtl();
      } catch (e) {
        this.onboarding.store.update({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!this.disposed) this.socket.enable();
    } else this.socket.disable();
  }

  onAppState(state: string): void {
    this.socket.onAppState(state);
    if (state === "active") void this.refresh().catch(() => undefined);
  }

  /** lock / sign-out / wallet change: close the socket before the key is wiped */
  dispose(): void {
    this.disposed = true;
    this.socket.disable();
  }
}
