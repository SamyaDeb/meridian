// Mock ETH-PERP (K7): the MON-PERP mock re-expressed on another market's grid. Prices × k, base sizes ÷ k, so every
// notional, margin and funding payment stays identical. With k = 100,000 the MON grid (tick 1e-6, lot 100) maps
// exactly onto the ETH grid (tick 0.1, lot 0.001). Vault, swaps and protocol stats pass through (MON-only layers).
import type { MeridianDataSource } from "../source";
import type { AccountMarket, AccountSummary, Address, Candle, DepthLevel, FundingTick, Market, RiskParamsView, Trade } from "../types";

export interface ScaledMarket {
  symbol: string;
  clearingHouse: Address;
  orderBook: Address;
  /** price multiplier (integer) */
  k: bigint;
  tickSizeWad: bigint;
  lotSizeWad: bigint;
  /** the scaled market's own caps (not the MON ones ÷ k) */
  maxOpenInterest: bigint;
  maxPositionSize: bigint;
}

export const ETH_MOCK_K = 100_000n;

const px = (s: ScaledMarket, p: bigint) => p * s.k;
const sz = (s: ScaledMarket, q: bigint) => q / s.k;

export function scaleMarket(s: ScaledMarket, m: Market): Market {
  return {
    ...m,
    id: s.clearingHouse,
    symbol: s.symbol,
    testMarket: false,
    clearingHouse: s.clearingHouse,
    orderBook: s.orderBook,
    lastCumFunding: px(s, m.lastCumFunding),
    lastCumIndexTime: px(s, m.lastCumIndexTime),
    lastIndexPrice: px(s, m.lastIndexPrice),
    lastMarkPrice: px(s, m.lastMarkPrice),
    lastTradePrice: px(s, m.lastTradePrice),
    volumeBaseWad: sz(s, m.volumeBaseWad),
    openInterestLongWad: sz(s, m.openInterestLongWad),
    openInterestShortWad: sz(s, m.openInterestShortWad),
  };
}

export function scaleTick(s: ScaledMarket, t: FundingTick): FundingTick {
  return { ...t, id: `${s.clearingHouse}-${t.block}`, market_id: s.clearingHouse, cumFunding: px(s, t.cumFunding), cumIndexTime: px(s, t.cumIndexTime), index: px(s, t.index), mark: px(s, t.mark) };
}

export function scaleTrade(s: ScaledMarket, t: Trade): Trade {
  const priceWad = px(s, t.priceWad);
  const sizeWad = sz(s, t.sizeWad);
  return { ...t, book: s.orderBook, market_id: s.clearingHouse, priceWad, sizeWad, tick: priceWad / s.tickSizeWad, lots: sizeWad / s.lotSizeWad };
}

export function scaleCandle(s: ScaledMarket, c: Candle): Candle {
  return { ...c, market: s.clearingHouse, open: px(s, c.open), high: px(s, c.high), low: px(s, c.low), close: px(s, c.close), volumeBaseWad: sz(s, c.volumeBaseWad) };
}

const scaleLevel = (s: ScaledMarket, l: DepthLevel): DepthLevel => ({ priceWad: px(s, l.priceWad), sizeWad: sz(s, l.sizeWad) });

export function scalePosition(s: ScaledMarket, p: AccountMarket): AccountMarket {
  return { ...p, id: `${s.clearingHouse}-${p.account_id}`, market_id: s.clearingHouse, size: sz(s, p.size), entryPrice: px(s, p.entryPrice), lastCumFunding: px(s, p.lastCumFunding) };
}

export function scaleAccount(s: ScaledMarket, a: AccountSummary): AccountSummary {
  return { ...a, size: sz(s, a.size), entryPrice: px(s, a.entryPrice), liquidationPrice: px(s, a.liquidationPrice) };
}

export function createScaledMockSource(inner: MeridianDataSource, s: ScaledMarket): MeridianDataSource {
  return {
    ...inner,
    kind: "mock",
    market: async () => scaleMarket(s, await inner.market()),
    fundingTicks: async (limit) => (await inner.fundingTicks(limit)).map((t) => scaleTick(s, t)),
    candles1m: async (limit) => (await inner.candles1m(limit)).map((c) => scaleCandle(s, c)),
    trades: async (limit) => (await inner.trades(limit)).map((t) => scaleTrade(s, t)),
    depth: async (levels) => {
      const d = await inner.depth(levels);
      return { bids: d.bids.map((l) => scaleLevel(s, l)), asks: d.asks.map((l) => scaleLevel(s, l)) };
    },
    positions: async (account) => (await inner.positions(account)).map((p) => scalePosition(s, p)),
    accountView: async (account) => {
      const a = await inner.accountView(account);
      return a === undefined ? undefined : scaleAccount(s, a);
    },
    riskParams: async (): Promise<RiskParamsView> => ({ ...(await inner.riskParams()), maxOpenInterest: s.maxOpenInterest, maxPositionSize: s.maxPositionSize }),
  };
}
