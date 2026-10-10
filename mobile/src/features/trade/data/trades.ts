// Meridian's recent public trades for Pro → Trades: the OrderBook `Trade` events (abis/OrderBook.json: makerOrderId,
// maker, taker indexed; takerIsBid, tick, lots, priceWad, sizeWad), read with eth_getLogs only while the Trades tab is on
// screen: a first window of BACKFILL_BLOCKS, then per new block from the last block read + 1 (one read in flight; a
// slow RPC skips blocks and catches up in one range, capped at MAX_RANGE). Newest first, bounded.
// > VERIFY: the configured Monad RPC's eth_getLogs block-range limit (kept ≤ MAX_RANGE = 100 blocks per request).
import { orderBookAbi } from "@meridian/core/meridian";
import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";
import { errText } from "../../../live/blockStore";
import type { TradeRow } from "../../../live/perplMarket";
import { Store } from "../../../live/store";

export const BACKFILL_BLOCKS = 100n;
export const MAX_RANGE = 100n;
export const MAX_ROWS = 50;

export type MeridianTradesState = { rows: readonly TradeRow[]; toBlock: bigint | undefined; error: string | undefined };

const TRADE_EVENT = orderBookAbi.find((x) => x.type === "event" && x.name === "Trade")!;

/** Logs → rows (taker's side), newest first: block desc, then log index desc. */
export function tradeRows(logs: readonly Log[], orderBook: Address): TradeRow[] {
  return parseEventLogs({ abi: orderBookAbi, eventName: "Trade", logs: logs as Log[] })
    .filter((l) => l.address.toLowerCase() === orderBook.toLowerCase())
    .sort((a, b) => (a.blockNumber === b.blockNumber ? (b.logIndex ?? 0) - (a.logIndex ?? 0) : Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n))))
    .map((l) => ({ venue: "meridian", side: l.args.takerIsBid ? "buy" : "sell", priceWad: l.args.priceWad, sizeWad: l.args.sizeWad, block: l.blockNumber === null ? undefined : Number(l.blockNumber), tMs: undefined, txHash: l.transactionHash ?? undefined }));
}

export class MeridianTradesReader {
  readonly store = new Store<MeridianTradesState>({ rows: [], toBlock: undefined, error: undefined });
  /** read only while the Trades tab is visible */
  readonly active = new Store(false);
  private inFlight = false;

  constructor(private readonly d: { client: Pick<PublicClient, "getLogs">; orderBook: Address }) {}

  onBlock(head: bigint): Promise<void> | undefined {
    if (!this.active.get() || this.inFlight) return undefined;
    const last = this.store.get().toBlock;
    if (last !== undefined && head <= last) return undefined;
    let from = last === undefined ? head - BACKFILL_BLOCKS + 1n : last + 1n;
    if (head - from + 1n > MAX_RANGE) from = head - MAX_RANGE + 1n;
    if (from < 0n) from = 0n;
    this.inFlight = true;
    return this.read(from, head).finally(() => {
      this.inFlight = false;
    });
  }

  private async read(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      const logs = await this.d.client.getLogs({ address: this.d.orderBook, event: TRADE_EVENT as never, fromBlock, toBlock });
      const fresh = tradeRows(logs as Log[], this.d.orderBook);
      const s = this.store.get();
      this.store.set({ rows: fresh.length ? [...fresh, ...s.rows].slice(0, MAX_ROWS) : s.rows, toBlock, error: undefined });
    } catch (e) {
      this.store.update({ error: errText(e) });
    }
  }
}
