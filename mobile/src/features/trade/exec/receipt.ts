// What the receipt modal shows (research §5.3): venue, average price, size, fee, order id / tx link, blocks to fill.
// Built from the terminal exec state + the leg's facts; one app-wide store so the modal route reads it without params.
import type { SingleState } from "@meridian/core/exec";
import type { Venue } from "@meridian/core/route";
import { divCeil, WAD } from "@meridian/core/util";
import type { Hex } from "viem";
import { Store } from "../../../live/store";
import { plainTradeError } from "./errors";

export type Receipt = {
  ok: boolean;
  venue: Venue;
  side: "long" | "short";
  reduceOnly: boolean;
  summary: string;
  filledWad: bigint;
  stepWad: bigint;
  avgPriceWad: bigint | undefined;
  priceDp: number;
  /** fee paid, quote WAD (Perpl: from its fills; Meridian: filled notional × taker fee, rounded up) */
  feeWad: bigint | undefined;
  orderId: number | undefined;
  txHash: Hex | undefined;
  explorerTxUrl: string | undefined;
  blocksToFill: bigint | undefined;
  error: string | undefined;
};

export type ReceiptFacts = {
  venue: Venue;
  side: "long" | "short";
  summary: string;
  stepWad: bigint;
  priceDp: number;
  takerFeeWad: bigint;
  explorerBase: string | undefined;
  sentAtBlock: bigint | undefined;
  /** Perpl */
  orderId?: number;
  feeCns?: bigint;
  collateralDecimals?: number;
  fillBlock?: bigint;
  /** Meridian */
  txHash?: Hex;
  receiptBlock?: bigint;
};

export function buildReceipt(s: SingleState, f: ReceiptFacts): Receipt {
  const ok = s.phase === "DONE";
  const filled = s.result?.filledWad ?? 0n;
  const avg = s.result?.avgPriceWad;
  let feeWad: bigint | undefined;
  if (ok && f.venue === "perpl" && f.feeCns !== undefined) feeWad = f.feeCns * 10n ** BigInt(18 - (f.collateralDecimals ?? 6));
  if (ok && f.venue === "meridian" && avg !== undefined) feeWad = divCeil(divCeil(filled * avg, WAD) * f.takerFeeWad, WAD); // owed ⇒ up
  const filledAt = f.venue === "meridian" ? f.receiptBlock : f.fillBlock;
  const blocksToFill = ok && filledAt !== undefined && f.sentAtBlock !== undefined && filledAt >= f.sentAtBlock ? filledAt - f.sentAtBlock : undefined;
  const txHash = f.venue === "meridian" ? f.txHash ?? (s.leg.ref as Hex | undefined) : undefined;
  return {
    ok,
    venue: f.venue,
    side: f.side,
    reduceOnly: s.order.reduceOnly,
    summary: f.summary,
    filledWad: filled,
    stepWad: f.stepWad,
    avgPriceWad: avg,
    priceDp: f.priceDp,
    feeWad,
    orderId: f.orderId,
    txHash,
    explorerTxUrl: txHash && f.explorerBase ? `${f.explorerBase.replace(/\/+$/, "")}/tx/${txHash}` : undefined,
    blocksToFill,
    error: ok ? undefined : plainTradeError(s.error),
  };
}

/** The latest receipt (the modal shows it; cleared when dismissed). */
export const receiptStore = new Store<Receipt | undefined>(undefined);
