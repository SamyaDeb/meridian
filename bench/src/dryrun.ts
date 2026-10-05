// B3/B4 dry-run planning (Phase 3 P6): what a load run WOULD send and cost, without a key or a send. Pure helpers.
// Billed gas per op comes from measured testnet receipts (bench/out/gas_onchain_10143_*.csv: Monad bills the gas
// LIMIT, R6); setup txs (approve + deposit) were never measured, so they are counted and left unpriced.
import { loadMix } from "./stats.js";

/** ARCHITECTURE R2 (mainnet) and R29 (testnet) public endpoints. */
export const PUBLIC_RPC_HOSTS = [
  "rpc.monad.xyz",
  "rpc1.monad.xyz",
  "rpc2.monad.xyz",
  "rpc3.monad.xyz",
  "rpc-mainnet.monadinfra.com",
  "testnet-rpc.monad.xyz",
  "rpc.ankr.com",
  "rpc-testnet.monadinfra.com",
];

/** What a report may say about an RPC: its tier, never the URL (a paid URL carries its API key). */
export function rpcTier(url: string): "local" | "public" | "private" {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "private";
  }
  if (host === "127.0.0.1" || host === "localhost") return "local";
  return PUBLIC_RPC_HOSTS.includes(host) ? "public" : "private";
}

/** op → billed gas limit from a gas_onchain CSV (header `op,gasUsed,gasLimit,…`). */
export function billedGasFromCsv(text: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  const [header, ...rows] = text.trim().split("\n");
  const cols = header!.split(",");
  const iOp = cols.indexOf("op");
  const iLim = cols.indexOf("gasLimit");
  for (const r of rows) {
    const c = r.split(",");
    m.set(c[iOp]!, BigInt(c[iLim]!));
  }
  return m;
}

export interface LoadPlan {
  perK: Array<{ k: number; place: number; cancel: number; market: number; gasLimit: bigint }>;
  loadTxs: number;
  setupTxs: number; // approve + deposit per wallet per market, per K (load.ts re-runs setup for each K); unpriced
  loadGasLimit: bigint;
  loadMonMilli: bigint; // MON × 1000 at the gas price, load txs only
}

/**
 * Mirror of bench/load.ts: per K, `loadMix(txs, 42 + k)` (a cancel with nothing open, or a market order on an empty side,
 * becomes a place at run time, so the split here is the planned one); each op's limit = billed estimate × 2 (load.ts
 * doubles estimate × 1.2). `billed` keys: place, cancel, match_1_fill.
 */
export function planLoad(p: { ks: number[]; txs: number; wallets: number; billed: Map<string, bigint>; gasPriceWei: bigint }): LoadPlan {
  const g = (op: string): bigint => {
    const v = p.billed.get(op);
    if (v === undefined) throw new Error(`no billed gas for ${op}`);
    return v * 2n;
  };
  const perK = p.ks.map((k) => {
    const mix = loadMix(p.txs, 42 + k);
    const place = mix.filter((x) => x === "place").length;
    const cancel = mix.filter((x) => x === "cancel").length;
    const market = mix.filter((x) => x === "market").length;
    return { k, place, cancel, market, gasLimit: BigInt(place) * g("place") + BigInt(cancel) * g("cancel") + BigInt(market) * g("match_1_fill") };
  });
  const loadGasLimit = perK.reduce((a, x) => a + x.gasLimit, 0n);
  return {
    perK,
    loadTxs: p.ks.length * p.txs,
    setupTxs: p.ks.reduce((a, k) => a + p.wallets * k * 2, 0),
    loadGasLimit,
    loadMonMilli: (loadGasLimit * p.gasPriceWei * 1000n) / 10n ** 18n,
  };
}
