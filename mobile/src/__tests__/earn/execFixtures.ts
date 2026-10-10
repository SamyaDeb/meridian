// Venue fakes for Earn's two-leg executor (no network), shared by exec.test.ts and closeAll.test.ts: they drive the REAL
// N5 leg adapters (Perpl IOC + order history, Meridian sign → persist raw → broadcast → receipt) and keep each venue's
// net position, so a test can compare what the venues hold with what the app shows.
import { orderBookAbi } from "@meridian/core/meridian";
import { OrderStatus, type PlaceResult } from "@meridian/core/perpl";
import type { BasisExecPlan } from "@meridian/core/exec";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex } from "viem";
import { EarnExecutor, type EarnExecutorDeps, type LegFactory } from "../../features/earn/executor";
import { withForcedMeridianFailure } from "../../features/earn/devFail";
import { earnRecordStore, positionStore } from "../../features/earn/record";
import { createMeridianLeg } from "../../features/trade/exec/meridianLeg";
import { createPerplLeg } from "../../features/trade/exec/perplLeg";

export const WAD = 10n ** 18n;
export const LOT = 100n * WAD;
export const ME = "0x00000000000000000000000000000000000000a1" as Address;
export const OB = "0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207" as Address;
export const MARKET = { id: 64, priceDecimals: 5, sizeDecimals: 0 };
export const noSleep = async () => {};

export type Ioc = { side: "buy" | "sell"; reduceOnly: boolean; sizeLns: number; limitPns: number };
export type BookFill = (o: { isBid: boolean; lots: bigint; reduceOnly: boolean }) => bigint | "revert";
export type Venues = { perplFill: (p: Ioc, n: number) => number; meridianFill: BookFill; swapFill?: BookFill };
/** the funding-swap book (a second OrderBook): lot 1,000 MON, price = 1 + APR, fills at 12 % fixed */
export const SB = "0x00000000000000000000000000000000000005b0" as Address;
export const SWAP_LOT = 1_000n * WAD;
export const SWAP_PX = 112n * 10n ** 16n;

/** Perpl: fills IOCs per `perplFill`, keeps an order history and the net position (lots, + long). Cloneable. */
export class FakePerpl {
  history: Record<string, unknown>[] = [];
  lfr = 41;
  net = 0;
  iocs: Ioc[] = [];
  constructor(private fill: Venues["perplFill"]) {}
  clone(): FakePerpl {
    const c = new FakePerpl(this.fill);
    Object.assign(c, { history: [...this.history], lfr: this.lfr, net: this.net, iocs: [...this.iocs] });
    return c;
  }
  get trading() {
    return {
      state: { account: { lfr: this.lfr } },
      ioc: async (p: Ioc) => {
        const n = this.iocs.length;
        this.iocs.push(p);
        const rq = ++this.lfr;
        let fs = Math.min(this.fill(p, n), p.sizeLns);
        if (p.reduceOnly) fs = Math.min(fs, Math.abs(this.net)); // reduce-only never flips
        this.net += p.side === "buy" ? fs : -fs;
        const o = { rq, mkt: 64, acc: 7, oid: 9000 + rq, st: fs > 0 ? OrderStatus.Filled : OrderStatus.Canceled, sr: 0, t: p.reduceOnly ? (p.side === "buy" ? 4 : 3) : p.side === "buy" ? 1 : 2, os: p.sizeLns, fp: fs > 0 ? 2567 : 0, fs, f: "0", fl: 4, lv: 200 };
        this.history.unshift(o);
        return { rq, sn: 1, lb: 1000, transport: "ws" as const, ack: Promise.resolve({ code: 0, error: "" }), outcome: Promise.resolve<PlaceResult>({ kind: "outcome", outcome: { rq, order: o as never, failed: false } }) };
      },
    };
  }
  get rest() {
    return { orderHistory: async () => ({ d: this.history }), fills: async () => ({ d: [] }) };
  }
}

/** Meridian: signs deterministically, mines on broadcast (fill per `meridianFill`), Trade logs for the taker. Cloneable. */
export class FakeChain {
  mined = new Map<Hex, { ok: boolean; size: bigint; isBid: boolean; to: Address }>();
  signed = new Map<Hex, { data: Hex; to: Address }>();
  nonce = 5;
  /** net perp MON on Meridian's book; net swap size on the swap book */
  net = 0n;
  swapNet = 0n;
  estimates = 0;
  constructor(
    private fill: BookFill,
    private swapFill: BookFill = (o) => o.lots,
  ) {}
  clone(): FakeChain {
    const c = new FakeChain(this.fill, this.swapFill);
    Object.assign(c, { mined: new Map(this.mined), signed: new Map(this.signed), nonce: this.nonce, net: this.net, swapNet: this.swapNet, estimates: this.estimates });
    return c;
  }
  log(to: Address, size: bigint, isBid: boolean) {
    const topics = encodeEventTopics({ abi: orderBookAbi, eventName: "Trade", args: { makerOrderId: 1n, maker: "0x00000000000000000000000000000000000000b2", taker: ME } });
    const px = to === SB ? SWAP_PX : 25864n * 10n ** 12n;
    const data = encodeAbiParameters([{ type: "bool" }, { type: "uint32" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }], [isBid, 25864, 3n, px, size]);
    return { address: to, topics, data, blockNumber: 70n, transactionHash: "0x" as Hex, logIndex: 0, blockHash: "0x" as Hex, transactionIndex: 0, removed: false };
  }
  get pub() {
    return {
      estimateGas: async () => {
        this.estimates++;
        return 100_000n;
      },
      getTransactionCount: async () => this.nonce,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const h = keccak256(serializedTransaction);
        if (!this.mined.has(h)) {
          const tx = this.signed.get(serializedTransaction)!;
          const { args } = decodeFunctionData({ abi: orderBookAbi, data: tx.data }) as { args: readonly [boolean, bigint, number, bigint, boolean] };
          const [isBid, lots, , , reduceOnly] = args;
          const swap = tx.to === SB;
          const f = (swap ? this.swapFill : this.fill)({ isBid, lots, reduceOnly });
          const size = f === "revert" ? 0n : f * (swap ? SWAP_LOT : LOT);
          this.mined.set(h, { ok: f !== "revert", size, isBid, to: tx.to });
          if (swap) this.swapNet += isBid ? size : -size;
          else this.net += isBid ? size : -size;
          this.nonce++;
        }
        return h;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const m = this.mined.get(hash);
        if (!m) throw new Error("not found");
        return { status: m.ok ? "success" : "reverted", blockNumber: 70n, logs: m.ok && m.size > 0n ? [this.log(m.to, m.size, m.isBid)] : [] };
      },
      call: async () => {
        throw new Error("SlippageExceeded");
      },
    };
  }
  get wallet() {
    return {
      account: { address: ME },
      chain: { id: 10143 },
      signTransaction: async (tx: { nonce: number; data: Hex; to: Address }) => {
        const raw = toHex(`signed-${tx.nonce}-${tx.to}-${tx.data}`);
        this.signed.set(raw, { data: tx.data, to: tx.to });
        return raw;
      },
    };
  }
}

export function memKv(init?: Map<string, string>) {
  const m = new Map(init);
  return { m, kv: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), del: async (k: string) => void m.delete(k) } };
}

export type World = { px: FakePerpl; ch: FakeChain; coll: { calls: number; fail?: string; lockWad?: bigint } };

export function legFactory(w: () => World): LegFactory {
  return (leg, io) => {
    if (leg.venue === "perpl") {
      const l = createPerplLeg({ trading: () => w().px.trading as never, rest: () => w().px.rest as never, market: MARKET, leverage100: io.meta.leverage100, head: () => 1001, saveRqFloor: (rq) => io.patch(rq !== undefined ? { rqFloor: rq } : {}) });
      return { legs: l.legs, findSent: l.findSent, orderId: l.orderId };
    }
    if (leg.venue === "swap") {
      const l = createMeridianLeg({ pub: w().ch.pub as never, wallet: () => w().ch.wallet as never, orderBook: SB, tickSizeWad: 10n ** 14n, lotSizeWad: SWAP_LOT, saveRaw: (raw, nonce) => io.patch({ raw, nonce }), loadRaw: () => io.note() });
      return { legs: l.legs };
    }
    const l = createMeridianLeg({ pub: w().ch.pub as never, wallet: () => w().ch.wallet as never, orderBook: OB, tickSizeWad: 10n ** 12n, lotSizeWad: LOT, saveRaw: (raw, nonce) => io.patch({ raw, nonce }), loadRaw: () => io.note() });
    return { legs: l.legs };
  };
}

export function executor(w: () => World, kv: ReturnType<typeof memKv>["kv"], o: Partial<EarnExecutorDeps> = {}) {
  return new EarnExecutor({
    chainId: 10143,
    address: ME,
    runs: earnRecordStore(kv, 10143, ME),
    positions: positionStore(kv, 10143, ME),
    legFor: legFactory(w),
    ensureCollateral: async (_p, _m, lockWad) => {
      w().coll.calls++;
      w().coll.lockWad = lockWad;
      if (w().coll.fail) throw new Error(w().coll.fail);
    },
    head: () => 1000n,
    explorerBase: "https://testnet.monadexplorer.com",
    sleep: noSleep,
    maxConfirmTries: 2,
    findTries: 1,
    wrapLegs: (legs, meta) => (meta.devFailMeridian ? withForcedMeridianFailure(legs) : legs),
    ...o,
  });
}

// Long 300 MON on Perpl first, then short 300 on Meridian
export const PLAN: BasisExecPlan = { perplSide: "buy", sizeWad: 300n * WAD, perplLimitPriceWad: 2593n * 10n ** 13n, meridianLimitPriceWad: 25600n * 10n ** 12n, meridianLotWad: LOT, perplStepWad: WAD, perplCollateralWad: 5n * WAD, meridianCollateralWad: 5n * WAD, unwindSlippageBps: 100n };
export const META = { summary: "Long 300 MON on Perpl · Short 300 MON on Meridian", perplPriceDp: 5, meridianPriceDp: 6, leverage100: 200 };

export const ALL: Venues = { perplFill: (p) => p.sizeLns, meridianFill: (o) => o.lots };
export function world(v: Venues = ALL): World {
  return { px: new FakePerpl(v.perplFill), ch: new FakeChain(v.meridianFill, v.swapFill), coll: { calls: 0 } };
}

/** venue net MON (Perpl lots are 1 MON) */
export const venueNet = (w: World) => BigInt(w.px.net) * WAD + w.ch.net;
export const shownLeftover = async (kv: ReturnType<typeof memKv>["kv"]) => {
  const p = await positionStore(kv, 10143, ME).load();
  return p.naked ? (p.naked.side === "buy" ? p.naked.sizeWad : -p.naked.sizeWad) : 0n;
};

