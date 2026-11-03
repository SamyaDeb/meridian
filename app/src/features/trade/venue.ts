"use client";
// Which venue the trade terminal shows: Meridian's selected market (default) or Perpl's MON perp as a view-only
// outside venue (its live chart, book and stats, labelled, never tradeable here). Kept in the URL (?venue=perpl) so a
// link opens it directly; only offered when NEXT_PUBLIC_PERPL_REFERENCE=1.
import { useSyncExternalStore } from "react";
import { PERPL_ENABLED } from "@/features/chart/datafeed/perpl";

export type Venue = "meridian" | "perpl";

const CHANGE_EVENT = "meridian:venue";

/** Pure: the venue a URL query names (anything but `perpl`, or the flag off, is Meridian). */
export function parseVenue(search: string, perplEnabled = PERPL_ENABLED): Venue {
  return perplEnabled && new URLSearchParams(search).get("venue") === "perpl" ? "perpl" : "meridian";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The venue on screen (server render + hydration: Meridian; the client then reads the URL). */
export const useVenue = (): Venue =>
  useSyncExternalStore(
    subscribe,
    () => parseVenue(window.location.search),
    () => "meridian",
  );

export function setVenue(v: Venue): void {
  const u = new URL(window.location.href);
  if (v === "perpl" && PERPL_ENABLED) u.searchParams.set("venue", "perpl");
  else u.searchParams.delete("venue");
  window.history.replaceState(window.history.state, "", u);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
