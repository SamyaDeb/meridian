"use client";
// Shared order-ticket draft (book / chart clicks write it, the ticket reads it). In-memory, per tab.
import { useSyncExternalStore } from "react";

export type Draft = {
  side: "long" | "short";
  kind: "market" | "limit";
  limitPx: string;
  /** size as typed (unit chosen in the ticket) */
  sizeIn: string;
  /** deposit / withdraw dialog of the ticket (palette and CTA open it) */
  funds: "deposit" | "withdraw" | null;
};
const INITIAL: Draft = { side: "long", kind: "market", limitPx: "", sizeIn: "", funds: null };
let draft: Draft = INITIAL;
const listeners = new Set<() => void>();

export function setDraft(patch: Partial<Draft>): void {
  draft = { ...draft, ...patch };
  listeners.forEach((l) => l());
}
export const getDraft = (): Draft => draft;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const SERVER: Draft = INITIAL;
/** Esc: clear what the user typed (side and order type stay). */
export const clearDraft = (): void => setDraft({ limitPx: "", sizeIn: "" });
export const useDraft = (): Draft => useSyncExternalStore(subscribe, getDraft, () => SERVER);
