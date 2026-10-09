// Meridian market-order leg, resume-safe (core exec/leg contract). `prepare` builds OrderBook.placeMarketOrder(isBid,
// lots, limitTick, minFilledLots, reduceOnly) (abis/OrderBook.json), estimates gas (a revert here = nothing sent, the
// reason is shown), sets gas = estimate × 1.2 (core gasLimitFromEstimate; Monad bills the limit), takes the pending
// nonce + EIP-1559 fees, SIGNS locally with the passkey session and persists the raw tx before returning its hash.
// `send` broadcasts that same raw tx (re-broadcast after a kill is a no-op by nonce). `confirm` reads the receipt:
// success ⇒ fills from the OrderBook `Trade` events with this wallet as taker; revert ⇒ the reason; no receipt while
// the nonce is still free ⇒ re-broadcast and retry; nonce taken by another tx ⇒ FAILED (nothing filled).
import type { LegAdapter, LegSpec } from "@meridian/core/exec";
import { gasLimitFromEstimate, orderBookAbi, priceToTick } from "@meridian/core/meridian";
import { divCeil, divFloor } from "@meridian/core/util";
import { encodeFunctionData, keccak256, parseEventLogs, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import type { SignerWallet } from "../../../wallet/sendTx";
import { explainTxError } from "../../../wallet/revert";

export type MeridianLegDeps = {
  pub: PublicClient;
  wallet: () => SignerWallet;
  orderBook: Address;
  tickSizeWad: bigint;
  lotSizeWad: bigint;
  /** persist the signed tx before it is broadcast; read it back on resume */
  saveRaw: (raw: Hex, nonce: number) => Promise<void>;
  loadRaw: () => { raw?: Hex; nonce?: number };
  receipts?: (r: TransactionReceipt) => void;
};

export type MeridianFill = { filledWad: bigint; avgPriceWad: bigint | undefined };

/** Σ size / Σ size·price of the Trade events where `taker` took liquidity in this receipt; avg buyer ↑ / seller ↓. */
export function fillsFromReceipt(r: Pick<TransactionReceipt, "logs">, orderBook: Address, taker: Address, isBid: boolean): MeridianFill {
  const events = parseEventLogs({ abi: orderBookAbi, eventName: "Trade", logs: r.logs }).filter((l) => l.address.toLowerCase() === orderBook.toLowerCase() && l.args.taker.toLowerCase() === taker.toLowerCase());
  let size = 0n;
  let px = 0n;
  for (const e of events) {
    size += e.args.sizeWad;
    px += e.args.sizeWad * e.args.priceWad;
  }
  return { filledWad: size, avgPriceWad: size === 0n ? undefined : isBid ? divCeil(px, size) : divFloor(px, size) };
}

export function createMeridianLeg(d: MeridianLegDeps) {
  let receipt: TransactionReceipt | undefined;

  const orderData = (leg: LegSpec): Hex => {
    const isBid = leg.side === "buy";
    const lots = leg.sizeWad / d.lotSizeWad;
    if (lots <= 0n) throw new Error("Size is below Meridian's minimum lot");
    const limitTick = priceToTick(leg.limitPriceWad, d.tickSizeWad, isBid ? "ask" : "bid"); // buy ↑, sell ↓ (never worse than asked)
    // opens are all-or-revert inside the limit (SlippageExceeded otherwise); a close takes what the book gives
    const minFilledLots = leg.reduceOnly ? 1n : lots;
    return encodeFunctionData({ abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, lots, limitTick, minFilledLots, leg.reduceOnly] });
  };

  const legs: LegAdapter = {
    async prepare(leg) {
      const wallet = d.wallet();
      const call = { account: wallet.account, to: d.orderBook, data: orderData(leg), value: 0n };
      let estimate: bigint;
      try {
        estimate = await d.pub.estimateGas(call);
      } catch (e) {
        throw new Error(explainTxError(e));
      }
      const nonce = await d.pub.getTransactionCount({ address: wallet.account.address, blockTag: "pending" });
      const fees = await d.pub.estimateFeesPerGas({ chain: wallet.chain, type: "eip1559" });
      const raw = await wallet.signTransaction({ ...call, chain: wallet.chain, type: "eip1559", gas: gasLimitFromEstimate(estimate), nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await d.saveRaw(raw, nonce);
      return keccak256(raw);
    },
    async send() {
      const { raw } = d.loadRaw();
      if (!raw) throw new Error("signed transaction missing");
      await d.pub.sendRawTransaction({ serializedTransaction: raw });
    },
    async confirm(leg, ref) {
      const hash = ref as Hex;
      const wallet = d.wallet();
      let r: TransactionReceipt | undefined;
      try {
        r = await d.pub.getTransactionReceipt({ hash });
      } catch {
        r = undefined;
      }
      if (!r) {
        const { raw, nonce } = d.loadRaw();
        const mined = await d.pub.getTransactionCount({ address: wallet.account.address, blockTag: "latest" });
        if (nonce !== undefined && mined > nonce) {
          // our nonce is used: either our tx (receipt lagging) or another one replaced it
          try {
            r = await d.pub.getTransactionReceipt({ hash });
          } catch {
            return { failed: "Another transaction from this wallet took its place. Nothing filled." };
          }
        } else {
          if (raw) await d.pub.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined);
          throw new Error("waiting for the transaction to be included");
        }
      }
      receipt = r;
      d.receipts?.(r);
      if (r.status !== "success") {
        let reason = "The order reverted. Nothing filled.";
        try {
          // re-simulate at the receipt's block to recover the reason (wallet/sendTx does the same)
          await d.pub.call({ account: wallet.account.address, to: d.orderBook, data: orderData(leg), blockNumber: r.blockNumber });
        } catch (e) {
          reason = explainTxError(e);
        }
        return { failed: reason };
      }
      const f = fillsFromReceipt(r, d.orderBook, wallet.account.address, leg.side === "buy");
      return { filledWad: f.filledWad, ...(f.avgPriceWad !== undefined ? { avgPriceWad: f.avgPriceWad } : {}) };
    },
  };

  return { legs, receipt: () => receipt };
}
