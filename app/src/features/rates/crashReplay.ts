// Block-by-block replay of a recorded crash (bench/out/crash_demo_*.csv via scripts/gen-crash-replay.mjs). Every
// number is a recorded value; nothing is interpolated between blocks.
import runs from "./crashReplay.gen.json";

export type CrashFrame = {
  offset: number;
  block: bigint;
  indexWad: bigint;
  markWad: bigint;
  vaultNavToken: bigint;
  ifBalanceToken: bigint;
  traderSizeWad: bigint;
  liquidatable: boolean;
  liquidatedHere: boolean;
};
export type CrashRun = { id: string; label: string; csv: string; explorer: string | null; frames: CrashFrame[]; liquidationBlock?: bigint };

const big = (v: string | undefined, f: string) => {
  if (v === undefined || !/^-?\d+$/.test(v)) throw new Error(`crash replay: bad ${f}`);
  return BigInt(v);
};

export function parseRun(r: { id: string; label: string; csv: string; explorer: string | null; rows: Record<string, string>[] }): CrashRun {
  const frames = r.rows.map((x) => ({
    offset: Number(big(x.block_offset, "block_offset")),
    block: big(x.block, "block"),
    indexWad: big(x.index_wad, "index_wad"),
    markWad: big(x.mark_wad, "mark_wad"),
    vaultNavToken: big(x.vault_nav_token, "vault_nav_token"),
    ifBalanceToken: big(x.if_balance_token, "if_balance_token"),
    traderSizeWad: big(x.trader_size_wad, "trader_size_wad"),
    liquidatable: x.trader_liquidatable === "1",
    liquidatedHere: x.liquidated_here === "1",
  }));
  const liq = frames.find((f) => f.liquidatedHere);
  return { id: r.id, label: r.label, csv: r.csv, explorer: r.explorer, frames, ...(liq ? { liquidationBlock: liq.block } : {}) };
}

export const CRASH_RUNS: CrashRun[] = (runs as Parameters<typeof parseRun>[0][]).map(parseRun);

/** Change of a token amount between two frames (the insurance fund's penalty inflow at the liquidation block). */
export const delta = (a: bigint, b: bigint) => b - a;
