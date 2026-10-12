// Perp markets the terminal can switch between (K7, PHASES decision 44): the primary market (deployments `contracts.*`,
// MON-PERP: the only one with the vault, funding swaps, the MFI and trigger orders) plus every market AddMarket.s.sol
// appended to the record's `markets` list (ETH-PERP on 10143). The demo market stays off the switcher (it keeps its TEST
// badge where it appears). Tick / lot come from the record (strings, WAD), never guessed. Pure.
import type { Address } from "@/data/types";
import type { Deployment } from "./deployments";
import { PERP_LOT_SIZE_WAD, PERP_TICK_SIZE_WAD, WAD } from "@/lib/units";

/** One entry of a deployment record's `markets` list (AddMarket.s.sol). */
export interface AddedMarketRecord {
  symbol: string;
  oracleKind: string;
  feedSymbol: string;
  pythFeedId: string;
  tickSizeWad: string;
  lotSizeWad: string;
  ClearingHouse: Address;
  OrderBook: Address;
  OracleAdapter: Address;
  startBlock: number;
}

export interface PerpMarket {
  /** "main" or the lower-case base coin of an added market ("eth"); used in ?market= and storage */
  key: string;
  symbol: string;
  /** base asset label shown next to sizes ("MON", "ETH") */
  base: string;
  clearingHouse: Address;
  orderBook: Address;
  oracle?: Address;
  tickSizeWad: bigint;
  lotSizeWad: bigint;
  /** decimals that show one lot exactly (lot 100 ⇒ 0, lot 0.001 ⇒ 3) */
  sizeDp: number;
  /** decimals that show one tick exactly (tick 1e-6 ⇒ 6, tick 0.1 ⇒ 1) */
  priceDp: number;
  /** MON-PERP: vault, swaps, MFI, triggers and the DEX reference chart exist only for it */
  primary: boolean;
  /** keeper-fed oracle on testnet (labelled in the UI) */
  keeperFed: boolean;
}

/** Decimals needed to print `wad` exactly (100e18 ⇒ 0, 1e15 ⇒ 3). Pure. */
export function decimalsFor(wad: bigint): number {
  if (wad <= 0n) return 0;
  let dp = 0;
  for (let scale = WAD; dp < 18 && wad % scale !== 0n; scale /= 10n) dp++;
  return dp;
}

const baseOf = (symbol: string): string => symbol.split("-")[0] ?? symbol;

/** Markets of a deployment record, primary first. Undefined record ⇒ []. Pure. */
export function perpMarkets(d: Deployment | undefined): PerpMarket[] {
  if (!d || !d.contracts.ClearingHouse || !d.contracts.OrderBook) return [];
  const symbol = d.symbol ?? "MON-PERP";
  const out: PerpMarket[] = [
    {
      key: "main",
      symbol,
      base: baseOf(symbol),
      clearingHouse: d.contracts.ClearingHouse,
      orderBook: d.contracts.OrderBook,
      ...(d.contracts.OracleAdapter ? { oracle: d.contracts.OracleAdapter } : {}),
      tickSizeWad: PERP_TICK_SIZE_WAD,
      lotSizeWad: PERP_LOT_SIZE_WAD,
      sizeDp: decimalsFor(PERP_LOT_SIZE_WAD),
      priceDp: decimalsFor(PERP_TICK_SIZE_WAD),
      primary: true,
      keeperFed: d.oracleKind === "keeper-fed",
    },
  ];
  for (const m of d.markets ?? []) {
    const tick = BigInt(m.tickSizeWad);
    const lot = BigInt(m.lotSizeWad);
    out.push({
      key: baseOf(m.symbol).toLowerCase(),
      symbol: m.symbol,
      base: baseOf(m.symbol),
      clearingHouse: m.ClearingHouse,
      orderBook: m.OrderBook,
      oracle: m.OracleAdapter,
      tickSizeWad: tick,
      lotSizeWad: lot,
      sizeDp: decimalsFor(lot),
      priceDp: decimalsFor(tick),
      primary: false,
      keeperFed: m.oracleKind === "keeper-fed",
    });
  }
  return out;
}

/**
 * Markets shown in the app: drops the non-primary markets whose key is in `hideCsv` (NEXT_PUBLIC_HIDE_MARKETS, e.g.
 * "eth" while that market's keeper and market maker aren't running, so nobody lands on a stale oracle and an empty
 * book). The primary market can't be hidden. Pure.
 */
export function visibleMarkets(markets: readonly PerpMarket[], hideCsv: string | undefined): PerpMarket[] {
  const hidden = new Set((hideCsv ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean));
  return markets.filter((m) => m.primary || !hidden.has(m.key));
}

/** The market for `key`, else the primary one. Pure. */
export function pickMarket(markets: readonly PerpMarket[], key: string | null | undefined): PerpMarket | undefined {
  return markets.find((m) => m.key === key) ?? markets[0];
}

/**
 * Mock-layer markets (no chain): the primary mock market plus a mock ETH-PERP on the ETH grid (tick 0.1, lot 0.001,
 * the testnet values), so the switcher and ETH formatting are testable without a node. Pure.
 */
export function mockMarkets(primary: { clearingHouse: Address; orderBook: Address; oracle?: Address }): PerpMarket[] {
  return [
    {
      key: "main",
      symbol: "MON-PERP",
      base: "MON",
      ...primary,
      tickSizeWad: PERP_TICK_SIZE_WAD,
      lotSizeWad: PERP_LOT_SIZE_WAD,
      sizeDp: 0,
      priceDp: 6,
      primary: true,
      keeperFed: false,
    },
    {
      key: "eth",
      symbol: "ETH-PERP",
      base: "ETH",
      clearingHouse: "0x00000000000000000000000000000000000E7401",
      orderBook: "0x00000000000000000000000000000000000E7402",
      tickSizeWad: 10n ** 17n,
      lotSizeWad: 10n ** 15n,
      sizeDp: 3,
      priceDp: 1,
      primary: false,
      keeperFed: true,
    },
  ];
}
