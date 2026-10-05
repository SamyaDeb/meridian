"use client";
// Resizable terminal layout (FRONTEND_TRADE_PLAN §6.7): book column width and bottom row height, per viewer.
import { useSyncExternalStore } from "react";

export type Layout = { bookW: number; posH: number };
export const LAYOUT_BOUNDS = { bookW: [220, 480], posH: [150, 420] } as const;
// chart-forward defaults (5 Oct redesign): book 280, positions 200; the chart takes the rest
export const DEFAULT_LAYOUT: Layout = { bookW: 280, posH: 200 };
const KEY = "meridian.layout.v2"; // v2: new defaults; sizes saved under v1 (taller positions) are not reused

export const clampLayout = (l: Partial<Layout>): Layout => ({
  bookW: Math.round(Math.min(LAYOUT_BOUNDS.bookW[1], Math.max(LAYOUT_BOUNDS.bookW[0], Number.isFinite(l.bookW) ? l.bookW! : DEFAULT_LAYOUT.bookW))),
  posH: Math.round(Math.min(LAYOUT_BOUNDS.posH[1], Math.max(LAYOUT_BOUNDS.posH[0], Number.isFinite(l.posH) ? l.posH! : DEFAULT_LAYOUT.posH))),
});

export function parseLayout(raw: string | null): Layout {
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const o = JSON.parse(raw) as Partial<Layout>;
    return clampLayout({ bookW: Number(o.bookW), posH: Number(o.posH) });
  } catch {
    return DEFAULT_LAYOUT;
  }
}

let cache: Layout | undefined;
const listeners = new Set<() => void>();
export function getLayout(): Layout {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  return (cache = parseLayout(raw));
}
export function setLayout(patch: Partial<Layout>): void {
  cache = clampLayout({ ...getLayout(), ...patch });
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: layout lasts for this page session */
  }
  listeners.forEach((l) => l());
}
export const resetLayout = () => setLayout(DEFAULT_LAYOUT);
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useLayout = (): Layout => useSyncExternalStore(subscribe, getLayout, () => DEFAULT_LAYOUT);
