// An Earn run as Activity lists it (activity/model.ts EarnRunEntry): built from the persisted run when it reaches a
// terminal phase. Both venues' filled sizes, the lock's, the plain timeline (without the one-tap close: a row in history
// never places an order) and the activity ids of its legs (Perpl order ids, Meridian tx hashes), so their fills from the
// venue feeds are shown as this one row.
import { tradeIdOf, type EarnRunEntry } from "../activity/model";
import type { EarnRecord } from "./record";
import type { EarnTimeline } from "./timeline";

export function earnRunEntry(rec: EarnRecord, timeline: EarnTimeline): EarnRunEntry {
  const s = rec.state;
  const legIds = new Set<string>();
  for (const n of Object.values(rec.meta.legs)) {
    if (n.orderId !== undefined) legIds.add(tradeIdOf("perpl", n.orderId, undefined)!);
    if (n.ref?.startsWith("0x")) legIds.add(tradeIdOf("meridian", undefined, n.ref)!);
  }
  const { leftover: _live, ...t } = timeline;
  const lock = s.kind === "basis" ? (s.lock && "filledWad" in s.lock ? s.lock.filledWad : undefined) : rec.meta.swapClose?.filledWad;
  return {
    run: s.kind === "basis" ? "open" : "close",
    runId: s.id,
    perplWad: s.kind === "basis" ? (s.q1?.filledWad ?? 0n) : s.perpl.filledWad,
    meridianWad: s.kind === "basis" ? (s.q2?.filledWad ?? 0n) : (s.meridian?.filledWad ?? 0n),
    ...(lock !== undefined ? { lockWad: lock } : {}),
    stepWad: s.plan.perplStepWad,
    timeline: t,
    legIds: [...legIds],
  };
}
