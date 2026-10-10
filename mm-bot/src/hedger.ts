// Perpl hedge runtime (K3.3): owns the Perpl trading connection, the Perpl market-data feed and the evidence log, and
// runs the pure policy (hedge.ts) once per MM tick. The MM keeps quoting whatever happens here: when the hedger refuses
// or halts, the MM just quotes unhedged on Meridian-only inventory (quoteInventory falls back).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MarketDataFeed, MarketDataSocket, createPerplClient, httpTransport, type Market } from "@meridian/mfi/perpl";
import { channelFromEnv, deliver, DEFAULT_PAGER, newPagerState, planPages } from "../../keepers/ts-fallback/src/paging.js";
import { decideHedge, haltReasons, quoteInventoryWad, scaledSizeToWad, type HedgeConfig, type HedgeDecision, type HedgeInputs } from "./hedge.js";
import { parseSecret, redact } from "./perpl/auth.js";
import type { PerplHedgeEnv } from "./perpl/config.js";
import { availableCollateral } from "./perpl/state.js";
import { PerplTrading, type PlaceResult } from "./perpl/trading.js";
import { OrderStatus } from "./perpl/types.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export type HedgerDeps = {
  log: Log;
  now?: () => number;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
};

export class PerplHedger {
  readonly trading: PerplTrading;
  private readonly feed: MarketDataFeed;
  private readonly md: MarketDataSocket;
  private readonly cfg: HedgeConfig;
  private market: Market | undefined;
  private inFlight = false;
  private lastHedgeMs: number | undefined;
  private consecutiveRejects = 0;
  private lastMerPos = 0n;
  private lastHold = "";
  private halted: string[] = [];
  private rates: HedgeInputs["rates"];
  private readonly pager = newPagerState();
  private readonly now: () => number;
  readonly stats = { hedges: 0, filled: 0, partial: 0, noFill: 0, rejected: 0, unknown: 0, holds: 0, halts: 0, cancels: 0 };

  constructor(
    private readonly e: PerplHedgeEnv,
    maxInventoryWad: bigint,
    private readonly d: HedgerDeps,
  ) {
    this.now = d.now ?? Date.now;
    this.cfg = { ...e.hedge, maxInventoryWad };
    this.trading = new PerplTrading({
      apiUrl: e.apiUrl,
      wsUrl: e.wsUrl,
      chainId: e.chainId,
      apiKey: e.apiKey,
      secret: parseSecret(e.apiSecretHex),
      marketId: e.marketId,
      orderTtlBlocks: 1, // set from /v1/pub/context in start(); no order can go out before (no account/head yet)
      ...(e.accountId !== undefined ? { accountId: e.accountId } : {}),
      ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}),
      log: (m, x) => d.log(m, x),
    });
    this.feed = new MarketDataFeed(e.marketId);
    this.md = new MarketDataSocket({ baseUrl: e.wsUrl, chainId: e.chainId, feed: this.feed, onEvent: (ev) => (ev.kind === "close" || ev.kind === "silent" || ev.kind === "gap" ? d.log("perpl market-data", { event: ev }) : undefined) });
  }

  /**
   * Startup checks (K3.2): market exists and is open, account exists (REST 404 ⇒ none), fw, collateral. Failing checks are
   * logged and the hedger stays in "refuse" mode (re-checked every tick); it never throws the MM down.
   */
  async start(): Promise<void> {
    const pub = createPerplClient({ transport: httpTransport(this.e.apiUrl, this.d.fetchFn ?? fetch) });
    const ctx = await pub.getContext();
    if (ctx.chain.chain_id !== this.e.chainId) throw new Error(`perpl context chain ${ctx.chain.chain_id} != PERPL_CHAIN_ID ${this.e.chainId}`);
    const m = ctx.markets.find((x) => x.id === this.e.marketId);
    if (!m) throw new Error(`perpl market ${this.e.marketId} not in /v1/pub/context`);
    const label = (m.symbol || m.name).toUpperCase();
    if (!label.startsWith(this.e.marketSymbol)) throw new Error(`perpl market ${m.id} is ${label}, expected ${this.e.marketSymbol}`);
    if (m.order_ttl_blocks === undefined) throw new Error("perpl context has no order_ttl_blocks");
    this.market = m;
    this.trading.setOrderTtlBlocks(m.order_ttl_blocks);
    try {
      await this.trading.restSnapshot();
    } catch (err) {
      const st = (err as { status?: number }).status;
      this.d.log("perpl hedge: REST snapshot failed", { status: st, error: String(err).slice(0, 200), hint: st === 404 ? "the hedge wallet has no Perpl exchange account (create + deposit at testnet.perpl.xyz)" : st === 401 ? "API key / signature refused" : undefined });
    }
    this.trading.start();
    this.md.start();
    const ok = await this.trading.waitReady(15_000);
    const i = this.inputs(this.lastMerPos, 0n);
    const reasons = haltReasons(this.cfg, i);
    this.d.log(reasons.length ? "perpl hedge: REFUSING to hedge (MM keeps quoting unhedged)" : "perpl hedge: ready", {
      tradingReady: ok,
      market: { id: m.id, symbol: label, priceDecimals: m.config.price_decimals, sizeDecimals: m.config.size_decimals, orderTtlBlocks: m.order_ttl_blocks, takerMicros: m.config.fees?.takerMicros },
      account: this.trading.state.account ? { id: this.trading.state.account.id, fw: this.trading.state.account.fw, available: availableCollateral(this.trading.state.account), lfr: this.trading.state.account.lfr } : null,
      perplPos: this.trading.state.netSize(),
      reasons,
    });
  }

  /** Position for the A–S inventory term (net delta when the hedge is live and its state fresh). */
  quoteInventory(merPosWad: bigint): bigint {
    const fresh = this.market !== undefined && this.halted.length === 0 && this.trading.ready && this.dataAgeMs() <= this.cfg.maxDataAgeMs;
    return quoteInventoryWad(merPosWad, this.market ? { posScaled: this.trading.state.netSize(), sizeDecimals: this.market.config.size_decimals, fresh } : undefined);
  }

  private dataAgeMs(): number {
    const now = this.now();
    const t = this.trading.state.lastFrameMs;
    const s = this.feed.state?.recvMs;
    if (t === undefined || s === undefined) return Infinity;
    return Math.max(now - t, now - s);
  }

  private inputs(merPosWad: bigint, indexWad: bigint): HedgeInputs {
    const m = this.market;
    const a = this.trading.state.account;
    const st = this.feed.state?.value;
    return {
      nowMs: this.now(),
      merPosWad,
      perplPosScaled: this.trading.state.netSize(),
      sizeDecimals: this.feed.config?.value.sizeDecimals ?? m?.config.size_decimals ?? 0,
      priceDecimals: this.feed.config?.value.priceDecimals ?? m?.config.price_decimals ?? 0,
      perplBid: st?.bid ?? 0,
      perplAsk: st?.ask ?? 0,
      meridianIndexWad: indexWad,
      perplDataAgeMs: this.dataAgeMs(),
      perplReady: this.trading.ready,
      fw: a?.fw,
      frozen: a?.fr,
      availableCollateral: a ? availableCollateral(a) : undefined,
      marketOpen: (this.feed.config?.value.isOpen ?? m?.config.is_open) === true,
      consecutiveRejects: this.consecutiveRejects,
      lastHedgeMs: this.lastHedgeMs,
      inFlight: this.inFlight,
      ...(this.rates ? { rates: this.rates } : {}),
    };
  }

  /** Funding rates for the optional bias, from the MFI service's /v1/mfi/spread (annualized WAD strings). */
  async refreshRates(): Promise<void> {
    if (!this.e.mfiUrl || !this.cfg.fundingBias) return;
    try {
      const r = (await (await (this.d.fetchFn ?? fetch)(`${this.e.mfiUrl.replace(/\/+$/, "")}/v1/mfi/spread?limit=1`)).json()) as { current?: { spread?: { meridianAprWad: string; perplAprWad: string } | null; stale?: boolean } | null };
      const s = r.current?.spread;
      this.rates = s && !r.current?.stale ? { meridianAprWad: BigInt(s.meridianAprWad), perplAprWad: BigInt(s.perplAprWad) } : undefined;
    } catch {
      this.rates = undefined;
    }
  }

  /** One policy step (called from the MM tick; never throws). */
  async step(merPosWad: bigint, indexWad: bigint, block: bigint): Promise<HedgeDecision> {
    this.lastMerPos = merPosWad;
    const i = this.inputs(merPosWad, indexWad);
    const dec = this.market ? decideHedge(this.cfg, i) : ({ action: "halt", reasons: ["perpl market not resolved"] } as HedgeDecision);
    try {
      if (dec.action === "halt") await this.onHalt(dec.reasons, block);
      else {
        if (this.halted.length) {
          this.d.log("perpl hedge: resumed", { block, was: this.halted });
          this.halted = [];
        }
        await this.page([]);
        if (dec.action === "hold") {
          this.stats.holds++;
          if (dec.reason !== this.lastHold) this.d.log("perpl hedge: hold", { block, reason: dec.reason, deltaWad: dec.deltaWad, targetWad: dec.targetWad });
          this.lastHold = dec.reason;
        } else await this.hedge(dec, i, block);
      }
    } catch (err) {
      this.d.log("perpl hedge: step error", { error: String(err).split("\n")[0] });
    }
    return dec;
  }

  private async onHalt(reasons: string[], block: bigint): Promise<void> {
    const changed = reasons.join("|") !== this.halted.join("|");
    if (changed) {
      this.stats.halts++;
      this.d.log("perpl hedge: HALT (kill switch / circuit breaker)", { block, reasons });
      this.evidence({ kind: "halt", block, reasons, perplPos: this.trading.state.netSize(), merPosWad: this.lastMerPos });
      await this.cancelResting("halt");
    }
    this.halted = reasons;
    await this.page(reasons.filter((r) => r !== "PERPL_HEDGE=0").map((r) => ({ code: `perpl_hedge_halt:${r.split(" ")[0]}`, severity: "critical" as const, message: r })));
  }

  private async page(alerts: { code: string; severity: "critical" | "warn"; message: string }[]): Promise<void> {
    const ch = channelFromEnv(this.d.env ?? {});
    if (ch.kind === "none") return;
    for (const text of planPages(this.pager, alerts as never, this.now() / 1000, DEFAULT_PAGER, "Meridian MM hedge")) {
      const r = await deliver(ch, text, (url, body) => (this.d.fetchFn ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json" }, body }));
      if (!r.ok) this.d.log("PAGE_FAILED", { detail: r.detail });
    }
  }

  private async hedge(dec: Extract<HedgeDecision, { action: "hedge" }>, i: HedgeInputs, block: bigint): Promise<void> {
    const o = dec.order;
    this.inFlight = true;
    this.lastHedgeMs = this.now();
    this.lastHold = "";
    this.stats.hedges++;
    const before = { merPosWad: i.merPosWad, perplPos: i.perplPosScaled };
    let placed;
    try {
      placed = await this.trading.place({ mkt: this.e.marketId, t: o.orderType, p: o.price, s: o.size, fl: o.flags, lv: o.leverage });
    } catch (err) {
      this.inFlight = false;
      this.consecutiveRejects++;
      this.stats.rejected++;
      this.d.log("perpl hedge: not sent", { error: String(err) });
      this.evidence({ kind: "hedge-not-sent", block, decision: dec, error: String(err) });
      return;
    }
    const base = { block, decision: dec, inputs: { bid: i.perplBid, ask: i.perplAsk, indexWad: i.meridianIndexWad, priceDecimals: i.priceDecimals, sizeDecimals: i.sizeDecimals }, rq: placed.rq, sn: placed.sn, lb: placed.lb, transport: placed.transport, before };
    this.d.log("perpl hedge: sent", { block, side: o.side, type: o.orderType, size: o.size, price: o.price, rq: placed.rq, transport: placed.transport, deltaWad: dec.deltaWad });
    this.evidence({ kind: "hedge-sent", ...base });
    void placed.outcome.then((r) => this.onOutcome(r, base));
  }

  private onOutcome(r: PlaceResult, base: Record<string, unknown>): void {
    this.inFlight = false;
    const after = { merPosWad: this.lastMerPos, perplPos: this.trading.state.netSize() };
    if (r.kind === "outcome") {
      const ord = r.outcome.order;
      const fills = this.trading.state.fills.filter((f) => ord.oid !== 0 && f.oid === ord.oid);
      const filled = ord.fs > 0 || fills.length > 0;
      if (r.outcome.failed) {
        this.consecutiveRejects++;
        this.stats.rejected++;
      } else {
        this.consecutiveRejects = 0;
        if (filled && ord.fs >= ord.os) this.stats.filled++;
        else if (filled) this.stats.partial++;
        else this.stats.noFill++;
      }
      this.d.log("perpl hedge: outcome", { rq: r.outcome.rq, oid: ord.oid, st: ord.st, sr: ord.sr, fr: ord.fr, fs: ord.fs, fp: ord.fp, failed: r.outcome.failed, perplPos: after.perplPos });
      this.evidence({ kind: "hedge-outcome", ...base, outcome: { oid: ord.oid, st: ord.st, sr: ord.sr, fr: ord.fr, os: ord.os, fs: ord.fs, fp: ord.fp, fee: ord.f, filled: ord.st === OrderStatus.Filled }, fills, after, consecutiveRejects: this.consecutiveRejects });
    } else {
      if (r.kind === "rejected") {
        this.consecutiveRejects++;
        this.stats.rejected++;
      } else this.stats.unknown++;
      this.d.log(`perpl hedge: ${r.kind}`, { ...(r.kind === "rejected" ? { code: r.code, error: r.error } : { reason: r.reason }) });
      this.evidence({ kind: `hedge-${r.kind}`, ...base, result: r, after, consecutiveRejects: this.consecutiveRejects });
      // unknown: reconcile from REST snapshots when the socket can't (README: never assume a lost request was dropped)
      if (r.kind === "unknown" && !this.trading.ready) void this.trading.restSnapshot().catch(() => undefined);
    }
  }

  /** Cancel every resting Perpl order of ours (IOC hedges never rest; this catches anything else). */
  async cancelResting(why: string): Promise<void> {
    for (const o of this.trading.openOrders()) {
      try {
        const p = await this.trading.cancel(o.oid);
        this.stats.cancels++;
        this.d.log("perpl hedge: cancel", { why, oid: o.oid, rq: p.rq });
        await Promise.race([p.outcome, new Promise((r) => setTimeout(r, 5_000))]);
      } catch (err) {
        this.d.log("perpl hedge: cancel failed", { why, oid: o.oid, error: String(err) });
      }
    }
  }

  /** SIGINT/SIGTERM: cancel resting Perpl orders, LEAVE positions (logged), close both sockets. */
  async shutdown(): Promise<void> {
    if (this.trading.ready) await this.cancelResting("shutdown");
    const pos = this.trading.state.netSize();
    this.d.log("perpl hedge: shutdown (positions left open)", { perplPos: pos, perplPosWad: this.market ? scaledSizeToWad(pos, this.market.config.size_decimals) : null, ...this.stats });
    this.evidence({ kind: "shutdown", perplPos: pos, merPosWad: this.lastMerPos, stats: this.stats });
    this.trading.stop();
    this.md.stop();
  }

  private evidence(rec: Record<string, unknown>): void {
    if (!this.e.evidencePath) return;
    try {
      mkdirSync(dirname(this.e.evidencePath), { recursive: true });
      appendFileSync(this.e.evidencePath, `${json(redact({ t: new Date(this.now()).toISOString(), ...rec }))}\n`);
    } catch (err) {
      this.d.log("perpl hedge: evidence write failed", { error: String(err) });
    }
  }
}
