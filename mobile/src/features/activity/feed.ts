// Activity feed: pulls each source (log.ts receipts, Perpl signed REST, Meridian indexer), keeps what each returned
// and merges them (model.ts). A source that fails says so in plain words and the others still show; a source that
// isn't available on this build (no Perpl key yet, no indexer URL) says why instead of looking empty. One page of the
// newest PAGE rows per source; pull-to-refresh reads them again.
import type { FetchLike } from "@meridian/core/util";
import { PerplHttpError, type Fill } from "@meridian/core/perpl";
import { errText } from "../../live/blockStore";
import { Store } from "../../live/store";
import type { ActivityLog } from "./log";
import { fromLog, mergeActivity, meridianActivity, MERIDIAN_ACTIVITY_QUERY, perplAccountEvents, perplTrades, type ActivityItem, type PerplAccountEvent, type PerplMarketMeta } from "./model";

export const PAGE = 50;

export type SourceStatus = { state: "off" | "loading" | "ok" | "error"; note: string | undefined };

export type ActivityState = {
  items: ActivityItem[];
  refreshing: boolean;
  perpl: SourceStatus;
  meridian: SourceStatus;
};

/** What the signed Perpl REST client offers (core createSignedRest). */
export type PerplHistoryRest = { fills(count?: number): Promise<unknown>; call(method: "GET", target: string): Promise<unknown> };

export type ActivityDeps = {
  log: ActivityLog;
  /** undefined ⇒ the Perpl source is off, `perplOff` says why */
  perpl: () => { rest: PerplHistoryRest; market: PerplMarketMeta } | undefined;
  perplOff: () => string;
  /** undefined ⇒ no indexer on this build */
  meridian: { url: string; account: string; fetchFn: FetchLike; meta: () => { priceDp: number; lotSizeWad: bigint | undefined } } | undefined;
  explorerBase: string | undefined;
};

const OFF_INDEXER = "Meridian history needs the indexer, which this build doesn't have yet. Your trades from this app are listed.";

/** POST a GraphQL query; `data` or throws (HTTP error, GraphQL error). Same contract as app/src/data/indexer/stats.ts postGql. */
export async function postGql(fetchFn: FetchLike, url: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, variables }) });
  if (res.status < 200 || res.status >= 300) throw new Error(`indexer: HTTP ${res.status}`);
  const body = JSON.parse(await res.text()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0]!.message}`);
  return body.data;
}

export class ActivityFeed {
  readonly store: Store<ActivityState>;
  private perplItems: ActivityItem[] = [];
  private meridianItems: ActivityItem[] = [];
  private inFlight: Promise<void> | undefined;

  constructor(private readonly d: ActivityDeps) {
    this.store = new Store<ActivityState>({
      items: [],
      refreshing: false,
      perpl: { state: "off", note: undefined },
      meridian: d.meridian ? { state: "off", note: undefined } : { state: "off", note: OFF_INDEXER },
    });
    d.log.store.subscribe(() => this.merge());
  }

  private merge(): void {
    this.store.update({ items: mergeActivity(fromLog(this.d.log.store.get()), this.perplItems, this.meridianItems) });
  }

  /** Read every source again (pull-to-refresh, after a trade, on open). Concurrent calls share one read. */
  refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    this.store.update({ refreshing: true });
    await this.d.log.load();
    this.merge();
    await Promise.all([this.readPerpl(), this.readMeridian()]);
    this.store.update({ refreshing: false });
  }

  private async readPerpl(): Promise<void> {
    const p = this.d.perpl();
    if (!p) {
      this.perplItems = [];
      this.store.update({ perpl: { state: "off", note: this.d.perplOff() } });
      this.merge();
      return;
    }
    this.store.update({ perpl: { state: "loading", note: undefined } });
    try {
      const [fills, history] = await Promise.all([p.rest.fills(PAGE), p.rest.call("GET", `/v1/trading/account-history?count=${PAGE}`)]);
      const f = ((fills as { d?: unknown } | undefined)?.d ?? []) as Fill[];
      const h = ((history as { d?: unknown } | undefined)?.d ?? []) as PerplAccountEvent[];
      if (!Array.isArray(f) || !Array.isArray(h)) throw new Error("Perpl sent history in a shape the app doesn't know");
      this.perplItems = [...perplTrades(f, p.market, this.d.explorerBase), ...perplAccountEvents(h, p.market.collateralDecimals)];
      this.store.update({ perpl: { state: "ok", note: undefined } });
    } catch (e) {
      if (e instanceof PerplHttpError && e.status === 404) {
        // rest-endpoints.md: 404 = the wallet holds no exchange account ⇒ nothing happened there
        this.perplItems = [];
        this.store.update({ perpl: { state: "ok", note: undefined } });
      } else this.store.update({ perpl: { state: "error", note: `Perpl history didn't load: ${errText(e)}` } });
    }
    this.merge();
  }

  private async readMeridian(): Promise<void> {
    const m = this.d.meridian;
    if (!m) return;
    this.store.update({ meridian: { state: "loading", note: undefined } });
    try {
      const data = await postGql(m.fetchFn, m.url, MERIDIAN_ACTIVITY_QUERY, { a: m.account, limit: PAGE });
      this.meridianItems = meridianActivity(data, m.account, { ...m.meta(), ...(this.d.explorerBase ? { explorerBase: this.d.explorerBase } : {}) });
      this.store.update({ meridian: { state: "ok", note: undefined } });
    } catch (e) {
      this.store.update({ meridian: { state: "error", note: `Meridian history didn't load: ${errText(e)}` } });
    }
    this.merge();
  }
}
