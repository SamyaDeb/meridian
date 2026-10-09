// Meridian market state, re-read once per new block (never more than one read in flight; a slow RPC simply skips
// blocks; reads are at `latest`, a load-balanced RPC may lag the head by a block). Reads go through one multicall: previewFundingState (funding rate), markPrice, indexPrice, both book sides via
// getDepth(·, DEPTH_LEVELS) (N5: the ticket walks them, Pro shows them). fundingParams().blockTimeMs, tick/lot size and
// riskParams (taker fee, imr, mmr) are read once per session. View names: abis/ClearingHouse.json,
// abis/OrderBook.json (typed fragments in @meridian/core/meridian).
import { clearingHouseAbi, orderBookAbi } from "@meridian/core/meridian";
import { meridianLevels } from "@meridian/core/route";
import type { BookLevel } from "@meridian/core/route";
import type { Address, PublicClient } from "viem";
import { errText } from "./blockStore";
import { Store } from "./store";

export type MeridianMarketState = {
  atBlock: bigint | undefined;
  /** previewFundingState().rate: per contract-second, WAD, signed */
  rateWad: bigint | undefined;
  /** fundingParams().blockTimeMs */
  paramBlockTimeMs: bigint | undefined;
  /** OrderBook.tickSize() (display precision of prices) */
  tickSizeWad: bigint | undefined;
  markWad: bigint | undefined;
  indexWad: bigint | undefined;
  /** undefined = that side of the book is empty */
  bestBidWad: bigint | undefined;
  bestAskWad: bigint | undefined;
  /** the depth read succeeded (so undefined best bid/ask really means "no liquidity") */
  bookKnown: boolean;
  /** both sides, best first, WAD (≤ DEPTH_LEVELS each); empty = no liquidity on that side */
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  /** OrderBook.lotSize() (size step) */
  lotSizeWad: bigint | undefined;
  /** riskParams(): takerFee, imr, mmr (WAD fractions) */
  takerFeeWad: bigint | undefined;
  imrWad: bigint | undefined;
  mmrWad: bigint | undefined;
  updatedAtMs: number | undefined;
  lastError: string | undefined;
};

const initial: MeridianMarketState = { atBlock: undefined, rateWad: undefined, paramBlockTimeMs: undefined, tickSizeWad: undefined, markWad: undefined, indexWad: undefined, bestBidWad: undefined, bestAskWad: undefined, bookKnown: false, bids: [], asks: [], lotSizeWad: undefined, takerFeeWad: undefined, imrWad: undefined, mmrWad: undefined, updatedAtMs: undefined, lastError: undefined };

/** Levels per side read each block (the ticket's walk + the Pro book). */
export const DEPTH_LEVELS = 20n;

export type MeridianReaderDeps = {
  client: Pick<PublicClient, "multicall">;
  clearingHouse: Address;
  orderBook: Address;
  now?: () => number;
};

export class MeridianMarketReader {
  readonly store = new Store<MeridianMarketState>(initial);
  private inFlight = false;
  private statics: { blockTimeMs: bigint; tickSize: bigint; lotSize: bigint } | undefined;
  private risk = false;
  private readonly now: () => number;

  constructor(private readonly d: MeridianReaderDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Called on every new head. Skips while a read is in flight or the block was already read. */
  onBlock(block: bigint): Promise<void> | undefined {
    const s = this.store.get();
    if (this.inFlight || (s.atBlock !== undefined && block <= s.atBlock)) return undefined;
    this.inFlight = true;
    return this.read(block).finally(() => {
      this.inFlight = false;
    });
  }

  private async loadStatics(): Promise<{ blockTimeMs: bigint; tickSize: bigint; lotSize: bigint }> {
    if (this.statics) return this.statics;
    const [fp, tick, lot] = await this.d.client.multicall({
      allowFailure: false,
      contracts: [
        { address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "fundingParams" },
        { address: this.d.orderBook, abi: orderBookAbi, functionName: "tickSize" },
        { address: this.d.orderBook, abi: orderBookAbi, functionName: "lotSize" },
      ],
    });
    this.statics = { blockTimeMs: fp.blockTimeMs, tickSize: tick, lotSize: lot };
    this.store.update({ paramBlockTimeMs: fp.blockTimeMs, tickSizeWad: tick, lotSizeWad: lot });
    return this.statics;
  }

  /** riskParams once (a failure is retried next block; the ticket shows Meridian as "reading…" meanwhile) */
  private async loadRisk(): Promise<void> {
    if (this.risk) return;
    const rp = await this.d.client.multicall({ allowFailure: true, contracts: [{ address: this.d.clearingHouse, abi: clearingHouseAbi, functionName: "riskParams" }] });
    const r = rp[0];
    if (r?.status !== "success") return;
    this.risk = true;
    this.store.update({ takerFeeWad: r.result.takerFee, imrWad: r.result.imr, mmrWad: r.result.mmr });
  }

  private async read(block: bigint): Promise<void> {
    try {
      const st = await this.loadStatics();
      await this.loadRisk().catch(() => undefined);
      const ch = this.d.clearingHouse;
      const ob = this.d.orderBook;
      const [fs, mark, index, bids, asks] = await this.d.client.multicall({
        allowFailure: true,
        contracts: [
          { address: ch, abi: clearingHouseAbi, functionName: "previewFundingState" },
          { address: ch, abi: clearingHouseAbi, functionName: "markPrice" },
          { address: ch, abi: clearingHouseAbi, functionName: "indexPrice" },
          { address: ob, abi: orderBookAbi, functionName: "getDepth", args: [true, DEPTH_LEVELS] },
          { address: ob, abi: orderBookAbi, functionName: "getDepth", args: [false, DEPTH_LEVELS] },
        ],
      });
      const bookKnown = bids.status === "success" && asks.status === "success";
      const levels = (r: typeof bids): BookLevel[] => {
        if (r.status !== "success") return [];
        const [ticks, lots] = r.result;
        return meridianLevels(ticks, lots, st.tickSize, st.lotSize);
      };
      const bidLv = bookKnown ? levels(bids) : undefined;
      const askLv = bookKnown ? levels(asks) : undefined;
      const failed = [fs, mark, index, bids, asks].find((r) => r.status === "failure");
      this.store.update({
        atBlock: block,
        rateWad: fs.status === "success" ? fs.result.rate : this.store.get().rateWad,
        markWad: mark.status === "success" ? mark.result : this.store.get().markWad,
        indexWad: index.status === "success" ? index.result : this.store.get().indexWad,
        bestBidWad: bidLv ? bidLv[0]?.priceWad : this.store.get().bestBidWad,
        bestAskWad: askLv ? askLv[0]?.priceWad : this.store.get().bestAskWad,
        ...(bidLv && askLv ? { bids: bidLv, asks: askLv } : {}),
        bookKnown: bookKnown || this.store.get().bookKnown,
        updatedAtMs: this.now(),
        lastError: failed?.status === "failure" ? errText(failed.error) : undefined,
      });
    } catch (e) {
      this.store.update({ lastError: errText(e) });
    }
  }
}
