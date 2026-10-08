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
