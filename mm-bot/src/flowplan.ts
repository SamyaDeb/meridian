// House taker flow for testnet (chart-liquidity prompt, task 1). Pure decisions + one injected-IO step, unit-tested in
// test/flow.test.ts; flow.ts only wires RPC. The MM (main.ts) is maker-only, so without a taker the book prints no
// trades and the chart has no candles. This bot sends occasional small market orders from its OWN key, which the
// deployments record lists under `mmAccounts`, so the indexer keeps it out of `externalUsers` and user volume.
// It never rests an order (IOC market orders only), so it can never trade against itself.

/** Empty ask side sentinel of OrderBook (`NO_ASK = type(uint32).max`, contracts/src/orderbook/OrderBook.sol). */
export const NO_ASK = 2 ** 32 - 1;

export interface FlowConfig {
  /** random wait between takes, seconds (FLOW_MIN_SEC ≤ wait ≤ FLOW_MAX_SEC) */
  minSec: number;
  maxSec: number;
  /** take size is uniform in [1, maxLots] lots (FLOW_MAX_LOTS) */
  maxLots: bigint;
  /** worst price vs the oracle index, bps (FLOW_MAX_SLIPPAGE_BPS) */
  maxSlippageBps: number;
  /** |position| cap in lots (FLOW_POSITION_CAP_LOTS): at or past it the next take reduces */
  positionCapLots: bigint;
}

export type Rng = () => number; // uniform in [0, 1)

/** Wait before the next take, ms: uniform in [minSec, maxSec]. */
export function nextDelayMs(rng: Rng, minSec: number, maxSec: number): number {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return Math.round((lo + rng() * (hi - lo)) * 1000);
}

export interface Take {
  isBid: boolean;
  lots: bigint;
  reduceOnly: boolean;
}

const absB = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Side and size of the next take from the signed position in lots (> 0 long).
 * - |pos| ≥ cap: reduce only (sell when long, buy when short), at most |pos| lots.
 * - otherwise random side, biased toward reducing: P(buy) = ½ − ½·pos/cap (½ when flat, → 0 near +cap, → 1 near −cap),
 *   and the take is clipped so |pos| never passes the cap on either side.
 */
export function decideTake(rng: Rng, posLots: bigint, cfg: Pick<FlowConfig, "maxLots" | "positionCapLots">): Take {
  const cap = cfg.positionCapLots > 0n ? cfg.positionCapLots : 1n;
  const maxLots = cfg.maxLots > 0n ? cfg.maxLots : 1n;
  const raw = 1n + BigInt(Math.floor(rng() * Number(maxLots))); // 1..maxLots
  const want = raw > maxLots ? maxLots : raw;
  if (absB(posLots) >= cap) {
    const isBid = posLots < 0n;
    return { isBid, lots: want < absB(posLots) ? want : absB(posLots), reduceOnly: true };
  }
  const pBuy = 0.5 - (0.5 * Number(posLots)) / Number(cap);
  const isBid = rng() < pBuy;
  const increases = isBid ? posLots >= 0n : posLots <= 0n;
  const room = increases ? cap - absB(posLots) : absB(posLots) + cap; // a reducing take may flip, but not past −cap
  const lots = want < room ? want : room;
  return { isBid, lots: lots > 0n ? lots : 1n, reduceOnly: false };
}

/** Worst acceptable tick for a take: index·(1 ± bps), buy rounds ↑ and sell ↓ to the tick grid (never 0). */
export function limitTickFor(isBid: boolean, indexWad: bigint, tickSize: bigint, slippageBps: number): number {
  const bps = BigInt(Math.max(0, Math.round(slippageBps)));
  if (isBid) {
    const px = (indexWad * (10_000n + bps) + 9_999n) / 10_000n;
    const t = (px + tickSize - 1n) / tickSize;
    return Number(t > BigInt(NO_ASK - 1) ? BigInt(NO_ASK - 1) : t);
  }
  const px = (indexWad * (10_000n - (bps > 10_000n ? 10_000n : bps))) / 10_000n;
  const t = px / tickSize;
  return Number(t < 1n ? 1n : t);
}

/** Refuses to start unless the flow key is its own account, distinct from the MM and listed as an operator. */
export function startupProblem(p: { flow: string; mm?: string | undefined; mmAccounts?: readonly string[] | undefined }): string | null {
  const flow = p.flow.toLowerCase();
  if (p.mm !== undefined && p.mm.toLowerCase() === flow) return "FLOW_PK must be a different key from MM_PK (the flow bot takes from the MM's quotes)";
  const listed = (p.mmAccounts ?? []).map((a) => a.toLowerCase());
  if (!listed.includes(flow)) {
    return `flow account ${p.flow} is not in the deployments record's mmAccounts: the indexer would count it as an external user. Add it there (and regenerate the indexer config) first`;
  }
  return null;
}

export interface FlowIo {
  killed(): boolean;
  /** oracle index (WAD) or null when stale / unreadable */
  index(): Promise<bigint | null>;
  /** signed position in base WAD */
  positionWad(): Promise<bigint>;
  /** best bid / best ask ticks (0 = no bids, NO_ASK = no asks) */
  book(): Promise<{ bestBid: number; bestAsk: number }>;
  /** estimate then send the market order with limit = estimate × 1.2; resolves with the receipt status */
  take(t: Take & { limitTick: number }): Promise<{ status: "success" | "reverted"; gasLimit: bigint }>;
}

export type StepResult =
  | { kind: "killed" }
  | { kind: "skip"; reason: "oracle stale" | "no liquidity" | "beyond slippage" }
  | { kind: "take"; take: Take & { limitTick: number }; status: "success" | "reverted"; gasLimit: bigint };

/**
 * One take: kill file → stop; stale oracle → skip; empty or too-far opposite side → skip (no tx, no gas: a market order
 * there would revert NoLiquidity / fill nothing); otherwise decideTake + limitTickFor + send.
 */
export async function flowStep(io: FlowIo, rng: Rng, cfg: FlowConfig, lotSize: bigint, tickSize: bigint): Promise<StepResult> {
  if (io.killed()) return { kind: "killed" };
  const [index, posWad, book] = await Promise.all([io.index(), io.positionWad(), io.book()]);
  if (index === null || index === 0n) return { kind: "skip", reason: "oracle stale" };
  const t = decideTake(rng, posWad / lotSize, cfg); // truncates toward zero: a sub-lot remainder never forces a reduce
  const opposite = t.isBid ? book.bestAsk : book.bestBid;
  if (t.isBid ? opposite === NO_ASK : opposite === 0) return { kind: "skip", reason: "no liquidity" };
  const limitTick = limitTickFor(t.isBid, index, tickSize, cfg.maxSlippageBps);
  if (t.isBid ? opposite > limitTick : opposite < limitTick) return { kind: "skip", reason: "beyond slippage" };
  if (io.killed()) return { kind: "killed" }; // re-check right before the only tx
  const take = { ...t, limitTick };
  const r = await io.take(take);
  return { kind: "take", take, status: r.status, gasLimit: r.gasLimit };
}
