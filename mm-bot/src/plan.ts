// Pure requote planner: the minimal replace / place / cancel set that turns our resting orders into the target
// ladder. replaceOrder is the hot path (< 100k gas, loses time priority), so moved orders are replaced, not
// cancelled and re-placed. Unit-tested in test/plan.test.ts.
import type { Level } from "./as.js";

export interface Resting {
  id: bigint;
  isBid: boolean;
  tick: number;
  lots: bigint;
}

export interface Plan {
  replace: Array<{ id: bigint; isBid: boolean; tick: number; lots: bigint }>;
  place: Array<{ isBid: boolean; tick: number; lots: bigint }>;
  cancel: bigint[];
}

function side(resting: readonly Resting[], isBid: boolean, target: readonly Level[]) {
  const mine = resting.filter((r) => r.isBid === isBid);
  const keep = new Set<bigint>();
  const todo: Level[] = [];
  for (const t of target) {
    const exact = mine.find((r) => !keep.has(r.id) && r.tick === t.tick && r.lots === t.lots);
    if (exact) keep.add(exact.id);
    else todo.push(t);
  }
  const free = mine.filter((r) => !keep.has(r.id));
  const replace = todo.slice(0, free.length).map((t, i) => ({ id: free[i]!.id, isBid, tick: t.tick, lots: t.lots }));
  const place = todo.slice(free.length).map((t) => ({ isBid, tick: t.tick, lots: t.lots }));
  const cancel = free.slice(todo.length).map((r) => r.id);
  return { replace, place, cancel };
}

/**
 * Moves are sequenced so our own quotes never cross each other mid-requote: when the market falls the bids move
 * (down) first, when it rises the asks move (up) first. Cancels go first (they only remove liquidity).
 */
export function planRequote(resting: readonly Resting[], target: { bids: readonly Level[]; asks: readonly Level[] }): Plan {
  const b = side(resting, true, target.bids);
  const a = side(resting, false, target.asks);
  const oldBest = Math.max(0, ...resting.filter((r) => r.isBid).map((r) => r.tick));
  const newBest = Math.max(0, ...target.bids.map((l) => l.tick));
  const falling = newBest !== 0 && oldBest !== 0 ? newBest < oldBest : false;
  return {
    replace: falling ? [...b.replace, ...a.replace] : [...a.replace, ...b.replace],
    place: falling ? [...b.place, ...a.place] : [...b.place, ...a.place],
    cancel: [...b.cancel, ...a.cancel],
  };
}

export interface RequoteInput {
  /** |index − last quoted index| in whole bps (floor) */
  movedBps: bigint;
  restingCount: number;
  /** size of the ladder we would build now (may be one-sided or shorter than 2·levels) */
  targetCount: number;
  /** every resting order still has its full size */
  allFull: boolean;
  /** |q − q at the last quote| */
  dq: number;
}

/** Requote only on a > 2 bps index move (MATH_SPEC §4), a missing/partially filled level, or a ≥ 0.05 inventory move. */
export function needsRequote(i: RequoteInput): boolean {
  return i.movedBps > 2n || i.restingCount < i.targetCount || !i.allFull || i.dq >= 0.05;
}
