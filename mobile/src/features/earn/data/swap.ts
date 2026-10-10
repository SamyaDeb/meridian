// The Meridian funding-swap market for Lock (MOBILE_PLAN N6 "Lock 30 d", MATH_SPEC §6): its book is a second OrderBook
// (deployments contracts.SwapOrderBook; price = 1 + fixed APR, WAD), its collateral is separate (FundingSwapMarket
// deposit). Read once: tick / lot, swapParams, maturity, ClearingHouse.fundingParams().rateCap (cap APR = rateCap·YEAR,
// as FundingSwapMarket._observe). Per block while Earn is on screen: both book sides (getDepth), markApr, τ
// (timeToMaturity), isMatured, the wallet's swap account (getAccount: collateral + accruedNet settled preview) and
// position (getPosition: size, fixedAprNotional = K). View names: core swapAbi / orderBookAbi / clearingHouseAbi.
import { clearingHouseAbi, orderBookAbi, swapAbi } from "@meridian/core/meridian";
import { meridianLevels, type BookLevel } from "@meridian/core/route";
import { SECONDS_PER_YEAR } from "@meridian/core/util";
import type { Address, PublicClient } from "viem";
import { errText } from "../../../live/blockStore";
import { Store } from "../../../live/store";

export const SWAP_DEPTH_LEVELS = 20n;

export type SwapParamsState = { liqHorizonSec: bigint; aprMoveBuffer: bigint; imMultiplier: bigint; takerFeeApr: bigint };

export type SwapState = {
  atBlock: bigint | undefined;
  tickSizeWad: bigint | undefined;
  lotSizeWad: bigint | undefined;
  params: SwapParamsState | undefined;
  /** maturity timestamp (s) */
  maturity: bigint | undefined;
  capAprWad: bigint | undefined;
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  bookKnown: boolean;
  markAprWad: bigint | undefined;
  tauSec: bigint | undefined;
  matured: boolean | undefined;
  /** the wallet's swap account: settled collateral (collateral + accruedNet), position size + K, its avg fixed APR */
  account: { collateralWad: bigint; sizeWad: bigint; kWad: bigint; avgFixedAprWad: bigint } | undefined;
  error: string | undefined;
};

const initial: SwapState = { atBlock: undefined, tickSizeWad: undefined, lotSizeWad: undefined, params: undefined, maturity: undefined, capAprWad: undefined, bids: [], asks: [], bookKnown: false, markAprWad: undefined, tauSec: undefined, matured: undefined, account: undefined, error: undefined };

export type SwapReaderDeps = { client: Pick<PublicClient, "multicall">; market: Address; book: Address; clearingHouse: Address; address: Address };

export class SwapReader {
  readonly store = new Store<SwapState>(initial);
  /** read per block only while a screen that needs it is on top (Earn, Close all) */
  readonly active = new Store(false);
  private inFlight = false;
  private holders = 0;

  constructor(private readonly d: SwapReaderDeps) {}

  /** Read per block while held; each holder releases once (focus / blur order between two screens can't switch reads off). */
  hold(): () => void {
    this.holders++;
    this.active.set(true);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holders = Math.max(0, this.holders - 1);
      if (this.holders === 0) this.active.set(false);
    };
  }

  onBlock(block: bigint): Promise<void> | undefined {
    const s = this.store.get();
    if (!this.active.get() || this.inFlight || (s.atBlock !== undefined && block <= s.atBlock)) return undefined;
    this.inFlight = true;
    return this.read(block).finally(() => {
      this.inFlight = false;
    });
  }

  private async statics(): Promise<void> {
    if (this.store.get().params) return;
    const { market, book, clearingHouse } = this.d;
    const [tick, lot, p, mat, fp] = await this.d.client.multicall({
      allowFailure: false,
      contracts: [
        { address: book, abi: orderBookAbi, functionName: "tickSize" },
        { address: book, abi: orderBookAbi, functionName: "lotSize" },
        { address: market, abi: swapAbi, functionName: "swapParams" },
        { address: market, abi: swapAbi, functionName: "maturity" },
        { address: clearingHouse, abi: clearingHouseAbi, functionName: "fundingParams" },
      ],
    });
    this.store.update({
      tickSizeWad: tick,
      lotSizeWad: lot,
      params: { liqHorizonSec: p.liqHorizonSec, aprMoveBuffer: p.aprMoveBuffer, imMultiplier: p.imMultiplier, takerFeeApr: p.takerFeeApr },
      maturity: mat,
      capAprWad: fp.rateCap * SECONDS_PER_YEAR,
    });
  }

  private async read(block: bigint): Promise<void> {
    try {
      await this.statics();
      const st = this.store.get();
      const { market, book, address } = this.d;
      const [bids, asks, mark, tau, matured, acc, pos] = await this.d.client.multicall({
        allowFailure: true,
        contracts: [
          { address: book, abi: orderBookAbi, functionName: "getDepth", args: [true, SWAP_DEPTH_LEVELS] },
          { address: book, abi: orderBookAbi, functionName: "getDepth", args: [false, SWAP_DEPTH_LEVELS] },
          { address: market, abi: swapAbi, functionName: "markApr" },
          { address: market, abi: swapAbi, functionName: "timeToMaturity" },
          { address: market, abi: swapAbi, functionName: "isMatured" },
          { address: market, abi: swapAbi, functionName: "getAccount", args: [address] },
          { address: market, abi: swapAbi, functionName: "getPosition", args: [address] },
        ],
      });
      const lv = (r: typeof bids) => (r.status === "success" ? meridianLevels(r.result[0], r.result[1], st.tickSizeWad!, st.lotSizeWad!) : undefined);
      const b = lv(bids);
      const a = lv(asks);
      const failed = [bids, asks, mark, tau, matured, acc, pos].find((r) => r.status === "failure");
      this.store.update({
        atBlock: block,
        ...(b && a ? { bids: b, asks: a, bookKnown: true } : {}),
        markAprWad: mark.status === "success" ? mark.result : st.markAprWad,
        tauSec: tau.status === "success" ? tau.result : st.tauSec,
        matured: matured.status === "success" ? matured.result : st.matured,
        account:
          acc.status === "success" && pos.status === "success"
            ? { collateralWad: BigInt(acc.result.collateral) + acc.result.accruedNet, sizeWad: pos.result.size, kWad: pos.result.fixedAprNotional, avgFixedAprWad: acc.result.avgFixedApr }
            : st.account,
        error: failed?.status === "failure" ? errText(failed.error) : undefined,
      });
    } catch (e) {
      this.store.update({ error: errText(e) });
    }
  }
}
