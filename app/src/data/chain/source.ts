// Chain data source: the perp read path straight from contract views + recent logs (anvil / testnet without an
// indexer). Vault, swaps and protocol stats still come from the mock until those contracts exist (fallback flag).
import type { PublicClient } from "viem";
import { clearingHouseAbi, orderBookAbi } from "@/lib/abi";
import { rateToAprWad } from "@/lib/math";
import { SECONDS_PER_YEAR } from "@/lib/units";
import type { PulseDataSource } from "../source";
import type { AccountMarket, Address, FundingTick, Market, Trade } from "../types";

export interface ChainAddresses {
  chainId: number;
  clearingHouse: Address;
  orderBook: Address;
  oracle?: Address;
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

const LOG_LOOKBACK = 2_000n; // blocks scanned for trades / ticks / orders (anvil or a paid RPC)
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
  const fromBlock = async () => {
    const head = await client.getBlockNumber();
    return head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
  };

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
    const logs = await client.getContractEvents({ ...ch, eventName: "FundingUpdated", fromBlock: await fromBlock(), strict: true });
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
    const logs = await client.getContractEvents({ ...ob, eventName: "Trade", fromBlock: await fromBlock(), strict: true });
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
      client.getContractEvents({ ...ch, eventName: "FundingSettled", args: { account }, fromBlock: await fromBlock(), strict: true }),
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
    const placed = await client.getContractEvents({ ...ob, eventName: "OrderPlaced", args: { maker: account }, fromBlock: await fromBlock(), strict: true });
    const views = await Promise.all(placed.map((l) => client.readContract({ ...ob, functionName: "getOrder", args: [l.args.orderId] })));
    return placed.flatMap((l, i) => {
      const o = views[i]!;
      return o.remainingLots === 0n ? [] : [{ id: l.args.orderId, isBid: o.isBid, tick: o.tick, priceWad: BigInt(o.tick) * tick, lots: o.remainingLots }];
    });
  }

  // Swaps are not deployed yet: never show the mock's positions next to real chain data.
  return { ...fallback, kind: "chain", market, fundingTicks, trades, depth, positions, openOrders, swapPositions: async () => [] };
}
