"use client";
// Viewer preferences (privacy toggles, sound, hotkeys). Per viewer in localStorage, every access guarded.
import { useSyncExternalStore } from "react";

export type Prefs = { hidePnl: boolean; hideLiq: boolean; hideBalances: boolean; sound: boolean; hotkeys: boolean };
export const DEFAULT_PREFS: Prefs = { hidePnl: false, hideLiq: false, hideBalances: false, sound: false, hotkeys: true };
const KEY = "meridian.prefs";

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const b = (k: keyof Prefs) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_PREFS[k]);
    return { hidePnl: b("hidePnl"), hideLiq: b("hideLiq"), hideBalances: b("hideBalances"), sound: b("sound"), hotkeys: b("hotkeys") };
  } catch {
    return DEFAULT_PREFS;
  }
}

let cache: Prefs | undefined;
const listeners = new Set<() => void>();
export function getPrefs(): Prefs {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  return (cache = parsePrefs(raw));
}
export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...getPrefs(), ...patch };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: preferences last for this page session */
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS);

/** Masks a value when its privacy toggle is on (the value is still in memory; this is a screen-share guard). */
export const MASK = "•••";
