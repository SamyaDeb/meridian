// Deterministic mock data with the exact shapes of indexer/SCHEMA.md. Pure functions of (block, now) so
// tests and screenshots are reproducible. Floats are used only to *generate* mock values.
import type {
  AccountMarket,
  Address,
  Candle,
  DepthLevel,
  FundingTick,
  Market,
  ProtocolStats,
  SwapMarketInfo,
  SwapPosition,
  SwapStats,
  Trade,
  Vault,
  VaultSnapshot,
  VaultUser,
} from "../types";
import { SECONDS_PER_YEAR, WAD, BLOCK_TIME_MS } from "@/lib/units";
import { contractAddress } from "@/config/deployments";

const CHAIN = 31337;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const MOCK = {
  chainId: CHAIN,
  clearingHouse: contractAddress(CHAIN, "ClearingHouse") ?? ZERO,
  orderBook: contractAddress(CHAIN, "OrderBook") ?? ZERO,
  vault: contractAddress(CHAIN, "PulseVault") ?? ZERO,
  swapMarket: "0x00000000000000000000000000000000000000F2" as Address, // not deployed yet (mock-only id)
  user: "0xa11ce00000000000000000000000000000000001" as Address,
  /** Mock chain epoch: block 0 at the start of the build window (1 Sep 2026). */
  genesisMs: Date.UTC(2026, 8, 1),
  /** One 30-day swap listed at mainnet launch (CP3, 10 Oct) ⇒ matures 9 Nov 2026 (MATH_SPEC §6.1). */
  swapMaturityMs: Date.UTC(2026, 10, 9),
};

const toWad = (x: number): bigint => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const DT = BLOCK_TIME_MS / 1000;

export const blockAt = (nowMs: number): bigint => BigInt(Math.max(0, Math.floor((nowMs - MOCK.genesisMs) / BLOCK_TIME_MS)));
const tsOfBlock = (b: bigint): bigint => BigInt(Math.floor((MOCK.genesisMs + Number(b) * BLOCK_TIME_MS) / 1000));

/** Index price around 0.029 AUSD/MON (ARCHITECTURE §0.1). */
const indexAt = (b: number): number => 0.029 * (1 + 0.02 * Math.sin(b / 5_000) + 0.004 * Math.sin(b / 97));
/** Funding APR oscillating around ~14% (floor 10.95%). */
const aprAt = (b: number): number => 0.14 + 0.05 * Math.sin(b / 20_000) + 0.01 * Math.sin(b / 700);

/** Closed-form cumulative indices (approximate; consistent across calls for a given block). */
function indices(b: number): { f: bigint; g: bigint } {
  const i = 0.029;
  const t = b * DT;
  const w = 20_000 * DT;
  const aprIntegral = 0.14 * t + 0.05 * w * (1 - Math.cos(t / w));
  return { f: toWad((i * aprIntegral) / Number(SECONDS_PER_YEAR)), g: toWad(i * t) };
}

export function fundingTick(block: bigint): FundingTick {
  const b = Number(block);
  const rateAprWad = toWad(aprAt(b));
  const rate = rateAprWad / SECONDS_PER_YEAR;
  const { f, g } = indices(b);
  const index = toWad(indexAt(b));
  const premium = toWad(0.0004 * Math.sin(b / 300));
  return {
    id: `${MOCK.clearingHouse}-${block}`,
    market_id: MOCK.clearingHouse,
    block,
    timestamp: tsOfBlock(block),
    rate,
    rateAprWad: rate * SECONDS_PER_YEAR,
    premium,
    emaPremium: premium / 2n,
    cumFunding: f,
    cumIndexTime: g,
    index,
    mark: index + (index * premium) / WAD,
  };
}

export function fundingTicks(head: bigint, limit: number): FundingTick[] {
  const out: FundingTick[] = [];
  for (let k = 0; k < limit && head - BigInt(k) >= 0n; k++) out.push(fundingTick(head - BigInt(k)));
  return out; // newest first, like `order_by: { block: desc }`
}

const realizedApr = (head: bigint, blocks: number): bigint | undefined => {
  if (head < BigInt(blocks)) return undefined;
  const a = indices(Number(head) - blocks);
  const b = indices(Number(head));
  return (((b.f - a.f) * WAD) / (b.g - a.g)) * SECONDS_PER_YEAR;
};

export function market(head: bigint): Market {
  const t = fundingTick(head);
  const h = Number(head);
  return {
    id: MOCK.clearingHouse,
    chainId: CHAIN,
    marketId: undefined,
    symbol: "MON-PERP",
    clearingHouse: MOCK.clearingHouse,
    orderBook: MOCK.orderBook,
    oracle: undefined,
    active: true,
    paused: false,
    lastFundingBlock: head,
    lastRate: t.rate,
    lastRateAprWad: t.rateAprWad,
    lastPremium: t.premium,
    lastEmaPremium: t.emaPremium,
    lastCumFunding: t.cumFunding,
    lastCumIndexTime: t.cumIndexTime,
    lastIndexPrice: t.index,
    lastMarkPrice: t.mark,
    fundingTickCount: h + 1,
    realizedApr1hWad: realizedApr(head, 12_000),
    realizedApr8hWad: realizedApr(head, 96_000),
    realizedApr24hWad: realizedApr(head, 288_000),
    lastTradePrice: (t.mark / 10n ** 12n) * 10n ** 12n,
    volumeBaseWad: toWad(48_200_000),
    volumeQuoteWad: toWad(1_397_800),
    tradeCount: 18_402,
    feesWad: toWad(612.4),
    feesCollectedToken: 0n,
    openInterestLongWad: toWad(3_150_000),
    openInterestShortWad: toWad(3_150_000),
    blockTimeMs: BigInt(BLOCK_TIME_MS),
  };
}

export function candles1m(head: bigint, limit: number): Candle[] {
  const perMin = 200; // blocks per minute at 300 ms
  const out: Candle[] = [];
  for (let k = 0; k < limit; k++) {
    const end = Number(head) - k * perMin;
    if (end < perMin) break;
    const px = Array.from({ length: 5 }, (_, j) => toWad(indexAt(end - j * 40)));
    const start = tsOfBlock(BigInt(end - perMin));
    out.push({
      id: `${MOCK.clearingHouse}-${start - (start % 60n)}`,
      market: MOCK.clearingHouse,
      bucketStart: start - (start % 60n),
      open: px[4]!,
      high: px.reduce((a, b) => (b > a ? b : a)),
      low: px.reduce((a, b) => (b < a ? b : a)),
      close: px[0]!,
      volumeBaseWad: toWad(20_000 + 15_000 * Math.abs(Math.sin(end))),
      volumeQuoteWad: toWad(600 + 400 * Math.abs(Math.sin(end))),
      trades: 3 + (end % 7),
    });
  }
  return out;
}

export function trades(head: bigint, limit: number): Trade[] {
  return Array.from({ length: limit }, (_, k) => {
    const block = head - BigInt(k * 3);
    const priceWad = (toWad(indexAt(Number(block))) / 10n ** 12n) * 10n ** 12n;
    const sizeWad = BigInt(1 + (Number(block) % 9)) * 100n * WAD;
    return {
      id: `${block}-0`,
      kind: "Perp" as const,
      book: MOCK.orderBook,
      market_id: MOCK.clearingHouse,
      swapMarket: undefined,
      makerOrderId: block,
      maker: MOCK.user,
      taker: MOCK.user,
      takerIsBid: Number(block) % 2 === 0,
      tick: priceWad / 10n ** 12n,
      lots: sizeWad / (100n * WAD),
      priceWad,
      sizeWad,
      notionalWad: (sizeWad * priceWad) / WAD,
      aprWad: undefined,
      block,
      timestamp: tsOfBlock(block),
      txHash: `0x${block.toString(16).padStart(64, "0")}`,
    };
  });
}

export function depth(head: bigint, levels: number): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const mid = (toWad(indexAt(Number(head))) / 10n ** 12n) * 10n ** 12n;
  const lvl = (side: 1n | -1n) =>
    Array.from({ length: levels }, (_, k) => ({
      priceWad: mid + side * BigInt(k + 1) * 10n ** 12n,
      sizeWad: BigInt(5 + ((k * 7 + Number(head)) % 40)) * 100n * WAD,
    }));
  return { bids: lvl(-1n), asks: lvl(1n) };
}

export function positions(head: bigint, account: Address): AccountMarket[] {
  const size = 50_000n * WAD; // long 50k MON
  const entry = 28_700n * 10n ** 12n; // 0.028700
  const { f } = indices(Number(head) - 40_000);
  return [
    {
      id: `${MOCK.clearingHouse}-${account}`,
      account_id: account,
      market_id: MOCK.clearingHouse,
      collateralWad: 480n * WAD,
      size,
      openNotional: (size * entry) / WAD,
      entryPrice: entry,
      lastCumFunding: f,
      fundingPaid: toWad(0.42),
      realizedPnl: toWad(3.1),
      feesPaid: toWad(0.72),
      reservedOrderMargin: 0n,
      depositedToken: 500_000_000n,
      withdrawnToken: 0n,
      liquidationCount: 0,
      updatedBlock: head - 40_000n,
    },
  ];
}

export function vault(head: bigint): Vault {
  const days = Number(head) * DT / 86_400;
  const sp = toWad(1 + 0.00042 * days);
  return {
    id: MOCK.vault,
    navToken: 8_420_130_000n,
    totalShares: (8_420n * WAD * WAD) / sp,
    sharePriceWad: sp,
    fundingAccruedWad: toWad(118.4),
    hedged: aprAt(Number(head)) > 0.156,
    lastRebalanceReason: "DeltaDrift",
    lastRebalanceBlock: head - 1_900n,
    depositedToken: 9_100_000_000n,
    withdrawnToken: 700_000_000n,
    userCount: 23,
    apy24hWad: days >= 1 ? toWad(0.153) : undefined,
    apy7dWad: days >= 7 ? toWad(0.149) : undefined,
  };
}

export function vaultSnapshots(head: bigint, limit: number): VaultSnapshot[] {
  const step = 12_000n; // hourly
  return Array.from({ length: limit }, (_, k) => {
    const block = head - BigInt(k) * step;
    const v = vault(block < 0n ? 0n : block);
    return {
      id: `${block}-0`,
      vault_id: MOCK.vault,
      navToken: v.navToken,
      totalShares: v.totalShares,
      sharePriceWad: v.sharePriceWad,
      fundingAccruedWad: v.fundingAccruedWad,
      block,
      timestamp: tsOfBlock(block),
    };
  }).filter((s) => s.block >= 0n);
}

export function vaultUser(head: bigint, account: Address): VaultUser {
  return { id: `${MOCK.vault}-${account}`, vault: MOCK.vault, user: account, shares: 250n * WAD, depositedToken: 250_000_000n, withdrawnToken: 0n, updatedBlock: head - 5_000n };
}

export function swapInfo(): SwapMarketInfo {
  return { id: MOCK.swapMarket, maturityTimestamp: Math.floor(MOCK.swapMaturityMs / 1000) };
}

export function swapStats(head: bigint): SwapStats {
  return {
    id: MOCK.swapMarket,
    markAprWad: toWad(0.1225),
    lastTradeBlock: head - 12n,
    realizedApr8hWad: realizedApr(head, 96_000),
    openInterestWad: toWad(12_500_000),
    volumeWad: toWad(41_000_000),
    tradeCount: 311,
    feesWad: toWad(96.2),
    matured: false,
  };
}

export function swapPositions(head: bigint, account: Address): SwapPosition[] {
  const q = 1_000_000n * WAD;
  const k = (q * toWad(0.12)) / WAD;
  return [
    {
      id: `${MOCK.swapMarket}-${account}`,
      swapMarket: MOCK.swapMarket,
      account_id: account,
      size: q,
      fixedAprNotional: k,
      avgFixedAprWad: toWad(0.12),
      lockedSpread: false,
      collateralWad: 2_300n * WAD,
      floatingReceived: toWad(21.7),
      fixedPaid: toWad(17.9),
      netAccrued: toWad(3.8),
      realizedPnl: 0n,
      feesPaid: toWad(0.8),
      liquidationCount: 0,
      updatedBlock: head - 800n,
    },
  ];
}

export function protocolStats(head: bigint): ProtocolStats {
  const v = vault(head);
  return {
    id: "protocol",
    users: 57,
    perpVolumeQuoteWad: toWad(1_397_800),
    swapVolumeWad: toWad(41_000_000),
    feesWad: toWad(708.6),
    tvlToken: 21_840_000_000n,
    perpCollateralToken: 11_120_000_000n,
    swapCollateralToken: 2_300_000_000n,
    vaultNavToken: v.navToken,
    trades: 18_713,
    liquidations: 4,
    fundingTicks: Number(head) + 1,
    keeperReports: 0,
    keeperReportFailures: 0,
  };
}

/** Mock risk params: the launch ratios the UI already assumes (units.ts); fees are mock-only values. */
export function riskParams(): import("../types").RiskParamsView {
  return {
    imr: 2n * 10n ** 17n,
    mmr: 10n ** 17n,
    takerFee: 5n * 10n ** 14n,
    makerFee: 0n,
    liqPenalty: 10n ** 16n,
    maxOpenInterest: 10_000_000n * WAD,
    maxPositionSize: 1_000_000n * WAD,
  };
}

/** Mock getAccount derived from the mock position with the same formulas the contract uses (MATH_SPEC §1.4, §3.2). */
export function accountView(head: bigint, account: Address): import("../types").AccountSummary | undefined {
  const p = positions(head, account)[0];
  if (!p) return undefined;
  const m = market(head);
  const r = riskParams();
  const absSize = p.size < 0n ? -p.size : p.size;
  const upnl = (p.size * m.lastMarkPrice) / WAD - p.openNotional;
  const prod = p.size * (m.lastCumFunding - p.lastCumFunding);
  const pending = prod / WAD + (prod % WAD !== 0n && prod > 0n ? 1n : 0n); // ceil
  const notional = (absSize * m.lastMarkPrice) / WAD;
  const mm = (notional * r.mmr) / WAD;
  const equity = p.collateralWad + upnl - pending;
  return {
    collateral: p.collateralWad,
    size: p.size,
    entryPrice: p.entryPrice,
    unrealizedPnl: upnl,
    pendingFunding: pending,
    equity,
    initialMargin: (notional * r.imr) / WAD + p.reservedOrderMargin,
    maintenanceMargin: mm,
    reservedOrderMargin: p.reservedOrderMargin,
    liquidationPrice: 0n,
    liquidatable: equity < mm,
  };
}
