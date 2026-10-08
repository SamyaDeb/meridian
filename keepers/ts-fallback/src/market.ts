// MARKET selection (K7, PHASES decision 44): which perp market of a deployment record this keeper serves.
//   main  = contracts.* (MON-PERP; the only market with the vault and swap duties)
//   demo  = demoMarket (MON-PERP-DEMO, labelled test market)
//   <key> = an entry of `markets` (AddMarket.s.sol) whose symbol starts with KEY- (e.g. "eth" ⇒ "ETH-PERP"), or the
//           full symbol. Its Pyth feed id comes from the record (`pythFeedId`, sourced from Hermes), and the keyless
//           fallback source quotes the base coin of the symbol on Hyperliquid ("ETH").
import type { Address, Hex } from "viem";

export type OracleKind = "pyth" | "keeper-fed" | "mock";

export interface MarketDeployment {
  ClearingHouse?: Address;
  OracleAdapter?: Address;
  OrderBook?: Address;
}

/** One entry of the record's `markets` list (AddMarket.s.sol `_newEntry`). */
export interface AddedMarket {
  symbol: string;
  oracleKind: OracleKind;
  feedSymbol: string;
  pythFeedId: Hex;
  tickSizeWad: string;
  lotSizeWad: string;
  baseAsset: Address;
  keeper?: Address;
  OracleAdapter: Address;
  ClearingHouse: Address;
  OrderBook: Address;
  startBlock: number;
}

export interface MarketRecord {
  chainId: number;
  startBlock: number;
  deployed?: boolean;
  symbol?: string;
  oracleKind?: OracleKind;
  contracts: MarketDeployment;
  demoMarket?: MarketDeployment & { symbol: string; testMarket: true; oracleKind: OracleKind };
  markets?: AddedMarket[];
}

export interface ResolvedMarket {
  /** "main" | "demo" | "added" */
  kind: "main" | "demo" | "added";
  symbol: string;
  clearingHouse: Address;
  oracle: Address;
  orderBook: Address | undefined;
  oracleKind: OracleKind;
  /** Pyth feed for the keeper-fed source; undefined ⇒ the PYTH_MON_USD_FEED_ID env (MON markets). */
  pythFeedId: Hex | undefined;
  /** Hyperliquid coin for the keyless fallback. */
  hyperliquidCoin: string;
  /** First block to scan for this market's events. */
  startBlock: number;
}

/** Base coin of a perp symbol: "ETH-PERP" ⇒ "ETH". */
export function baseCoin(symbol: string): string {
  return symbol.split("-")[0] ?? symbol;
}

/** The added market for `key` (case-insensitive: "eth" ⇒ ETH-PERP, or the full symbol), or undefined. */
export function findAddedMarket(rec: MarketRecord, key: string): AddedMarket | undefined {
  const k = key.toUpperCase();
  return (rec.markets ?? []).find((m) => m.symbol.toUpperCase() === k || baseCoin(m.symbol).toUpperCase() === k);
}

/**
 * Resolves MARKET against a deployment record. Throws with a readable reason when the market is absent or not
 * deployed. Pure.
 */
export function resolveMarket(rec: MarketRecord, key: string, path = "deployments"): ResolvedMarket {
  if (rec.deployed === false) throw new Error(`${path}: not a deployed record`);
  if (key === "main" || key === "demo") {
    const m = key === "demo" ? rec.demoMarket : rec.contracts;
    if (m === undefined) throw new Error(`MARKET=${key}: no demoMarket in ${path}`);
    if (m.ClearingHouse === undefined || m.OracleAdapter === undefined) throw new Error(`${path}: market ${key} is not deployed`);
    const symbol = key === "demo" ? (rec.demoMarket?.symbol ?? "MON-PERP-DEMO") : (rec.symbol ?? "MON-PERP");
    return {
      kind: key,
      symbol,
      clearingHouse: m.ClearingHouse,
      oracle: m.OracleAdapter,
      orderBook: m.OrderBook,
      oracleKind: (key === "demo" ? rec.demoMarket?.oracleKind : rec.oracleKind) ?? "pyth",
      pythFeedId: undefined,
      hyperliquidCoin: "MON",
      startBlock: rec.startBlock,
    };
  }
  const a = findAddedMarket(rec, key);
  if (a === undefined) {
    const known = (rec.markets ?? []).map((m) => m.symbol).join(", ") || "none";
    throw new Error(`MARKET=${key}: not main, demo or an added market in ${path} (markets: ${known})`);
  }
  return {
    kind: "added",
    symbol: a.symbol,
    clearingHouse: a.ClearingHouse,
    oracle: a.OracleAdapter,
    orderBook: a.OrderBook,
    oracleKind: a.oracleKind,
    pythFeedId: a.pythFeedId,
    hyperliquidCoin: baseCoin(a.symbol),
    startBlock: a.startBlock,
  };
}
