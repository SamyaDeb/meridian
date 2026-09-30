// Chain data source: contract views + recent logs (anvil / testnet without an indexer). Perp always; vault and funding
// swaps when their addresses are in the deployment (else that part stays on the mock); protocol stats stay mock.
import type { PublicClient } from "viem";
import { clearingHouseAbi, orderBookAbi, swapAbi, vaultAbi } from "@/lib/abi";
import { snapshotsFromLogs, swapPositionFromViews } from "@/lib/earnfix";
import { rateToAprWad, vaultApyWad } from "@/lib/math";
import { SECONDS_PER_YEAR } from "@/lib/units";
import type { PulseDataSource } from "../source";
import type { AccountMarket, Address, FundingTick, Market, SwapMarketInfo, SwapPosition, SwapStats, Trade, Vault, VaultSnapshot, VaultUser } from "../types";

export interface ChainAddresses {
  chainId: number;
  clearingHouse: Address;
  orderBook: Address;
  oracle?: Address;
  vault?: Address;
  swapMarket?: Address;
  swapOrderBook?: Address;
  /** Blocks of history scanned for trades / ticks / orders (default 2,000: anvil or a paid RPC). */
  logLookback?: bigint;
  /** eth_getLogs range cap per request (default = lookback; public Monad RPC 100, Alchemy free tier 10). */
  logSpan?: bigint;
}

export interface OpenOrder {
  id: bigint;
  isBid: boolean;
  tick: number;
  priceWad: bigint;
  lots: bigint;
}

export interface ChainSource extends PulseDataSource {
  openOrders(account: Address): Promise<OpenOrder[]>;
}

const LOG_LOOKBACK = 2_000n; // default blocks scanned for trades / ticks / orders (anvil or a paid RPC)

/** Pure: [from, to] split into inclusive ranges of at most `span` blocks (RPC eth_getLogs caps). */
export function blockRanges(from: bigint, to: bigint, span: bigint): Array<[bigint, bigint]> {
  if (span <= 0n) throw new Error("span must be > 0");
  const out: Array<[bigint, bigint]> = [];
  for (let s = from; s <= to; s += span) out.push([s, s + span - 1n < to ? s + span - 1n : to]);
  return out;
}
const WINDOWS: Array<[keyof Pick<Market, "realizedApr1hWad" | "realizedApr8hWad" | "realizedApr24hWad">, number]> = [
  ["realizedApr1hWad", 3_600],
  ["realizedApr8hWad", 28_800],
  ["realizedApr24hWad", 86_400],
];

export function createChainSource(client: PublicClient, a: ChainAddresses, fallback: PulseDataSource): ChainSource {
  const ch = { address: a.clearingHouse, abi: clearingHouseAbi } as const;
  const ob = { address: a.orderBook, abi: orderBookAbi } as const;
  let units: Promise<{ tick: bigint; lot: bigint }> | undefined;
  const bookUnits = () =>
    (units ??= Promise.all([
      client.readContract({ ...ob, functionName: "tickSize" }),
      client.readContract({ ...ob, functionName: "lotSize" }),
    ]).then(([tick, lot]) => ({ tick, lot })));
  const lookback = a.logLookback ?? LOG_LOOKBACK;
  const span = a.logSpan ?? lookback + 1n;
  /** Logs of the last `lookback` blocks, fetched in `span`-block chunks (sequential: public RPCs are rate-limited). */
  async function recent<T>(fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
    const head = await client.getBlockNumber();
    const out: T[] = [];
    for (const [f, t] of blockRanges(head > lookback ? head - lookback : 0n, head, span)) out.push(...(await fetch(f, t)));
    return out;
  }

  async function market(): Promise<Market> {
    const [fs, mark, index, [longOI, shortOI], paused, fp, head] = await Promise.all([
      client.readContract({ ...ch, functionName: "previewFundingState" }),
      client.readContract({ ...ch, functionName: "markPrice" }),
      client.readContract({ ...ch, functionName: "indexPrice" }),
      client.readContract({ ...ch, functionName: "openInterest" }),
      client.readContract({ ...ch, functionName: "paused" }),
      client.readContract({ ...ch, functionName: "fundingParams" }),
      client.getBlockNumber(),
    ]);
    // realized APR windows = the contract's own averageFundingApr (undefined until the window has history)
    const aprs = await Promise.all(
      WINDOWS.map(([, sec]) =>
        client
          .readContract({ ...ch, functionName: "averageFundingApr", args: [BigInt(Math.floor((sec * 1000) / Number(fp.blockTimeMs)))] })
          .catch(() => undefined),
      ),
    );
    const m: Market = {
      id: a.clearingHouse,
      chainId: a.chainId,
      symbol: "MON-PERP",
      clearingHouse: a.clearingHouse,
      orderBook: a.orderBook,
      ...(a.oracle ? { oracle: a.oracle } : {}),
      active: true,
      paused,
      lastFundingBlock: head, // previewFundingState is "as of now"
      lastRate: fs.rate,
      lastRateAprWad: rateToAprWad(fs.rate),
      lastPremium: 0n,
      lastEmaPremium: fs.emaPremium,
      lastCumFunding: fs.cumFunding,
      lastCumIndexTime: fs.cumIndexTime,
      lastIndexPrice: index,
      lastMarkPrice: mark,
      fundingTickCount: 0,
      lastTradePrice: 0n,
      volumeBaseWad: 0n,
      volumeQuoteWad: 0n,
      tradeCount: 0,
      feesWad: 0n,
      feesCollectedToken: 0n,
      openInterestLongWad: longOI,
      openInterestShortWad: shortOI,
      blockTimeMs: fp.blockTimeMs,
    };
    WINDOWS.forEach(([k], i) => {
      const v = aprs[i];
      if (v !== undefined) m[k] = v;
    });
    return m;
  }

  async function fundingTicks(limit: number): Promise<FundingTick[]> {
    const logs = await recent((fromBlock, toBlock) => client.getContractEvents({ ...ch, eventName: "FundingUpdated", fromBlock, toBlock, strict: true }));
    return logs
      .slice(-limit)
      .reverse()
      .map((l) => ({
        id: `${a.clearingHouse}-${l.args.blockNumber}`,
        market_id: a.clearingHouse,
        block: l.args.blockNumber,
        timestamp: 0n,
        rate: l.args.rate,
        rateAprWad: l.args.rate * SECONDS_PER_YEAR,
        premium: l.args.premium,
        emaPremium: l.args.emaPremium,
        cumFunding: l.args.cumFunding,
        cumIndexTime: l.args.cumIndexTime,
        index: l.args.indexPriceWad,
        mark: l.args.markPriceWad,
      }));
  }

  async function trades(limit: number): Promise<Trade[]> {
    const logs = await recent((fromBlock, toBlock) => client.getContractEvents({ ...ob, eventName: "Trade", fromBlock, toBlock, strict: true }));
    return logs
      .slice(-limit)
      .reverse()
      .map((l) => ({
        id: `${l.blockNumber}-${l.logIndex}`,
        kind: "Perp" as const,
        book: a.orderBook,
        market_id: a.clearingHouse,
        makerOrderId: l.args.makerOrderId,
        maker: l.args.maker,
        taker: l.args.taker,
        takerIsBid: l.args.takerIsBid,
        tick: BigInt(l.args.tick),
        lots: l.args.lots,
        priceWad: l.args.priceWad,
        sizeWad: l.args.sizeWad,
        notionalWad: (l.args.priceWad * l.args.sizeWad) / 10n ** 18n,
        block: l.blockNumber,
        timestamp: 0n,
        txHash: l.transactionHash,
      }));
  }

  async function depth(levels: number) {
    const { tick, lot } = await bookUnits();
    const side = async (isBid: boolean) => {
      const [ticks, lots] = await client.readContract({ ...ob, functionName: "getDepth", args: [isBid, BigInt(levels)] });
      return ticks.map((t, i) => ({ priceWad: BigInt(t) * tick, sizeWad: (lots[i] ?? 0n) * lot }));
    };
    const [bids, asks] = await Promise.all([side(true), side(false)]);
    return { bids, asks };
  }

  async function positions(account: Address): Promise<AccountMarket[]> {
    const [v, p, settled, head] = await Promise.all([
      client.readContract({ ...ch, functionName: "getAccount", args: [account] }),
      client.readContract({ ...ch, functionName: "getPosition", args: [account] }),
      recent((fromBlock, toBlock) =>
        client.getContractEvents({ ...ch, eventName: "FundingSettled", args: { account }, fromBlock, toBlock, strict: true }),
      ),
      client.getBlockNumber(),
    ]);
    return [
      {
        id: `${a.clearingHouse}-${account}`,
        account_id: account,
        market_id: a.clearingHouse,
        collateralWad: v.collateral,
        size: p.size,
        openNotional: p.openNotional,
        entryPrice: v.entryPrice,
        lastCumFunding: p.lastCumFunding,
        fundingPaid: settled.reduce((s, l) => s + l.args.payment, 0n), // over the lookback window
        realizedPnl: 0n,
        feesPaid: 0n,
        reservedOrderMargin: v.reservedOrderMargin,
        depositedToken: 0n,
        withdrawnToken: 0n,
        liquidationCount: 0,
        updatedBlock: head,
      },
    ];
  }

  async function openOrders(account: Address): Promise<OpenOrder[]> {
    const { tick } = await bookUnits();
    const placed = await recent((fromBlock, toBlock) =>
      client.getContractEvents({ ...ob, eventName: "OrderPlaced", args: { maker: account }, fromBlock, toBlock, strict: true }),
    );
    const views = await Promise.all(placed.map((l) => client.readContract({ ...ob, functionName: "getOrder", args: [l.args.orderId] })));
    return placed.flatMap((l, i) => {
      const o = views[i]!;
      return o.remainingLots === 0n ? [] : [{ id: l.args.orderId, isBid: o.isBid, tick: o.tick, priceWad: BigInt(o.tick) * tick, lots: o.remainingLots }];
    });
  }

  // ─── vault (PulseVault) ───
  const vt = a.vault ? ({ address: a.vault, abi: vaultAbi } as const) : undefined;
  /** chain time of `block` ≈ head timestamp − (head − block)·blockTime (one header read, no per-log block reads) */
  async function clock(): Promise<(b: bigint) => bigint> {
    const [head, fp] = await Promise.all([client.getBlock({ blockTag: "latest" }), client.readContract({ ...ch, functionName: "fundingParams" })]);
    return (b) => head.timestamp - ((head.number - b) * fp.blockTimeMs) / 1000n;
  }
  async function vaultSnapshots(limit: number): Promise<VaultSnapshot[]> {
    if (!vt) return fallback.vaultSnapshots(limit);
    const [logs, ts] = await Promise.all([recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "NavSnapshot", fromBlock, toBlock, strict: true })), clock()]);
    return snapshotsFromLogs(vt.address, logs, ts).slice(0, limit);
  }
  async function vault(): Promise<Vault> {
    if (!vt) return fallback.vault();
    const [nav, supply, price, h, needs, cap, snaps, deposits, withdraws, rebal, ts, head] = await Promise.all([
      client.readContract({ ...vt, functionName: "totalAssets" }),
      client.readContract({ ...vt, functionName: "totalSupply" }),
      client.readContract({ ...vt, functionName: "sharePrice" }),
      client.readContract({ ...vt, functionName: "hedgeState" }),
      client.readContract({ ...vt, functionName: "needsRebalance" }),
      client.readContract({ ...vt, functionName: "shortCapacity" }),
      vaultSnapshots(1_000),
      recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "Deposit", fromBlock, toBlock, strict: true })),
      recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "Withdraw", fromBlock, toBlock, strict: true })),
      recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "Rebalanced", fromBlock, toBlock, strict: true })),
      clock(),
      client.getBlockNumber(),
    ]);
    // APY from the share price: the oldest snapshot in the lookback → the live price now (per-block funding shows)
    const oldest = snaps[snaps.length - 1];
    const dt = oldest ? ts(head) - oldest.timestamp : 0n;
    const apy = oldest && dt > 0n ? vaultApyWad(oldest.sharePriceWad, price, dt) : undefined;
    const last = rebal[rebal.length - 1];
    const REASONS = ["None", "Deploy", "DeltaDrift", "MarginLow", "ExitHedge", "EnterHedge", "Withdraw", "SkewCap"] as const;
    return {
      id: vt.address,
      navToken: nav,
      totalShares: supply,
      sharePriceWad: price,
      fundingAccruedWad: snaps[0]?.fundingAccruedWad ?? 0n,
      hedged: h.hedged,
      lastRebalanceReason: last ? (REASONS[last.args.reason] ?? "None") : "None",
      lastRebalanceBlock: h.lastRebalanceBlock,
      depositedToken: deposits.reduce((x, l) => x + l.args.assets, 0n), // over the lookback window
      withdrawnToken: withdraws.reduce((x, l) => x + l.args.assets, 0n),
      userCount: new Set(deposits.map((l) => l.args.owner.toLowerCase())).size,
      ...(apy !== undefined ? { apyWad: apy, apyWindowSec: Number(dt) } : {}),
      needsRebalance: needs,
      idleToken: h.idleAssets,
      shortCapacityWad: cap,
      spotBaseWad: h.spotBase,
      perpSizeWad: h.perpSize,
      netDeltaWad: h.netDelta,
      marginRatioWad: h.marginRatio,
    };
  }
  async function vaultUser(account: Address): Promise<VaultUser | undefined> {
    if (!vt) return fallback.vaultUser(account);
    const [shares, dep, wd, head] = await Promise.all([
      client.readContract({ ...vt, functionName: "balanceOf", args: [account] }),
      recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "Deposit", args: { owner: account }, fromBlock, toBlock, strict: true })),
      recent((fromBlock, toBlock) => client.getContractEvents({ ...vt, eventName: "Withdraw", args: { owner: account }, fromBlock, toBlock, strict: true })),
      client.getBlockNumber(),
    ]);
    return {
      id: `${vt.address}-${account}`,
      vault: vt.address,
      user: account,
      shares,
      depositedToken: dep.reduce((x, l) => x + l.args.assets, 0n),
      withdrawnToken: wd.reduce((x, l) => x + l.args.assets, 0n),
      updatedBlock: head,
    };
  }

  // ─── funding swaps (FundingSwapMarket + its OrderBook) ───
  const sw = a.swapMarket ? ({ address: a.swapMarket, abi: swapAbi } as const) : undefined;
  const sob = a.swapOrderBook ? ({ address: a.swapOrderBook, abi: orderBookAbi } as const) : undefined;
  async function swapInfo(): Promise<SwapMarketInfo> {
    if (!sw) return fallback.swapInfo();
    const m = await client.readContract({ ...sw, functionName: "maturity" });
    return { id: sw.address, maturityTimestamp: Number(m), ...(sob ? { orderBook: sob.address } : {}) };
  }
  async function swapStats(): Promise<SwapStats> {
    if (!sw) return fallback.swapStats();
    const fp = await client.readContract({ ...ch, functionName: "fundingParams" });
    const blocks8h = (28_800n * 1000n) / fp.blockTimeMs;
    const [mark, realized, [longOI], matured, trades] = await Promise.all([
      client.readContract({ ...sw, functionName: "markApr" }),
      client.readContract({ ...sw, functionName: "realizedApr", args: [blocks8h] }).catch(() => undefined),
      client.readContract({ ...sw, functionName: "openInterest" }),
      client.readContract({ ...sw, functionName: "isMatured" }),
      sob ? recent((fromBlock, toBlock) => client.getContractEvents({ ...sob, eventName: "Trade", fromBlock, toBlock, strict: true })) : Promise.resolve([]),
    ]);
    return {
      id: sw.address,
      markAprWad: mark,
      lastTradeBlock: trades[trades.length - 1]?.blockNumber ?? 0n,
      ...(realized !== undefined ? { realizedApr8hWad: realized } : {}),
      openInterestWad: longOI,
      volumeWad: trades.reduce((x, l) => x + l.args.sizeWad, 0n), // over the lookback window
      tradeCount: trades.length,
      feesWad: 0n,
      matured,
    };
  }
  async function swapPositions(account: Address): Promise<SwapPosition[]> {
    if (!sw) return []; // never show the mock's swap positions next to real chain data
    const [p, v, head] = await Promise.all([
      client.readContract({ ...sw, functionName: "getPosition", args: [account] }),
      client.readContract({ ...sw, functionName: "getAccount", args: [account] }),
      client.getBlockNumber(),
    ]);
    if (p.size === 0n && p.fixedAprNotional === 0n && v.collateral === 0n) return [];
    return [swapPositionFromViews(sw.address, account, p, v, head)];
  }

  return {
    ...fallback,
    kind: "chain",
    market,
    fundingTicks,
    trades,
    depth,
    positions,
    openOrders,
    vault,
    vaultSnapshots,
    vaultUser,
    swapInfo,
    swapStats,
    swapPositions,
  };
}
