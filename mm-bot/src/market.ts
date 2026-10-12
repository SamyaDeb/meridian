// Which perp book the MM quotes (K7, PHASES decision 44): MARKET = main (contracts.*), demo (demoMarket) or an added
// market of the record's `markets` list (AddMarket.s.sol), by base coin ("eth") or full symbol ("ETH-PERP").
// MARKET=swap is handled by main.ts (it quotes the swap book with the main market's CH/oracle). Pure.
import type { Address } from "viem";

export interface PerpMarket {
  ClearingHouse?: Address;
  OrderBook?: Address;
  OracleAdapter?: Address;
}

export interface AddedPerpMarket extends Required<PerpMarket> {
  symbol: string;
  startBlock: number;
}

export interface PerpRecord {
  deployed?: boolean;
  symbol?: string;
  contracts: PerpMarket;
  demoMarket?: PerpMarket & { symbol: string };
  markets?: AddedPerpMarket[];
}

export interface ResolvedPerp {
  symbol: string;
  clearingHouse: Address;
  orderBook: Address;
  oracle: Address;
}

/** Resolves a perp MARKET ("swap" resolves to the main market, whose CH/oracle the swap MM uses). */
export function resolvePerpMarket(rec: PerpRecord, key: string, path = "deployments"): ResolvedPerp {
  let m: PerpMarket | undefined;
  let symbol: string;
  if (key === "main" || key === "swap") {
    m = rec.contracts;
    symbol = rec.symbol ?? "MON-PERP";
  } else if (key === "demo") {
    m = rec.demoMarket;
    symbol = rec.demoMarket?.symbol ?? "MON-PERP-DEMO";
  } else {
    const k = key.toUpperCase();
    const a = (rec.markets ?? []).find((x) => x.symbol.toUpperCase() === k || x.symbol.split("-")[0]?.toUpperCase() === k);
    if (a === undefined) {
      const known = (rec.markets ?? []).map((x) => x.symbol).join(", ") || "none";
      throw new Error(`MARKET=${key}: not main, demo, swap or an added market in ${path} (markets: ${known})`);
    }
    m = a;
    symbol = a.symbol;
  }
  if (rec.deployed === false || m?.ClearingHouse === undefined || m.OrderBook === undefined || m.OracleAdapter === undefined) {
    throw new Error(`${path}: market ${key} is not deployed`);
  }
  return { symbol, clearingHouse: m.ClearingHouse, orderBook: m.OrderBook, oracle: m.OracleAdapter };
}

/** One entry of the record's `swapMarkets` list (AddSwapMarket.s.sol, CR-017): a swap book on an external venue's funding. */
export interface SwapMarketEntry {
  symbol: string;
  fundingSource: string;
  PerplFundingSource: Address;
  FundingSwapMarket: Address;
  SwapOrderBook: Address;
  deployed: boolean;
}

export interface ResolvedSwapBook {
  symbol: string;
  swapMarket: Address;
  orderBook: Address;
  /** The swap market's funding source when it is not the main ClearingHouse (Perpl: PerplFundingSource). */
  perplSource: Address | undefined;
}

/**
 * MARKET=swap book: SWAP_MARKET unset ⇒ the main market's `contracts.FundingSwapMarket` (Meridian funding); "perpl" or a
 * `swapMarkets[]` symbol ⇒ that entry, refused unless `deployed: true`. Pure.
 */
export function resolveSwapBook(
  rec: { contracts: { FundingSwapMarket?: Address; SwapOrderBook?: Address }; swapMarkets?: SwapMarketEntry[] },
  key: string | undefined,
  path = "deployments",
): ResolvedSwapBook {
  if (key === undefined) {
    const { FundingSwapMarket: fs, SwapOrderBook: ob } = rec.contracts;
    if (fs === undefined || ob === undefined) throw new Error(`${path}: no FundingSwapMarket/SwapOrderBook`);
    return { symbol: "MON-FUNDING", swapMarket: fs, orderBook: ob, perplSource: undefined };
  }
  const k = key.toUpperCase();
  const all = rec.swapMarkets ?? [];
  const e = all.find((x) => x.symbol.toUpperCase() === k) ?? (k === "PERPL" ? all.find((x) => x.fundingSource === "perpl") : undefined);
  if (e === undefined) throw new Error(`SWAP_MARKET=${key}: not in ${path} swapMarkets (${all.map((x) => x.symbol).join(", ") || "none"})`);
  if (e.deployed !== true) throw new Error(`${path}: swap market ${e.symbol} is not deployed`);
  return { symbol: e.symbol, swapMarket: e.FundingSwapMarket, orderBook: e.SwapOrderBook, perplSource: e.fundingSource === "perpl" ? e.PerplFundingSource : undefined };
}
