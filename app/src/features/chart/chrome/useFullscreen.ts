"use client";
// Full screen for the chart card: the browser's Fullscreen API when the element supports it, otherwise an in-page
// overlay (the card pins itself over the viewport). Leaving is symmetric. Written for Meridian.
import { useCallback, useEffect, useState, type RefObject } from "react";

export type FullscreenAction = "exit-native" | "enter-native" | "toggle-overlay";

/** Pure: what a toggle should do, given whether some element is natively full screen and whether ours can be. */
export function nextFullscreenAction(nativeActive: boolean, canRequest: boolean): FullscreenAction {
  if (nativeActive) return "exit-native";
  return canRequest ? "enter-native" : "toggle-overlay";
}

export function useFullscreen(target: RefObject<HTMLElement | null>): { full: boolean; toggle: () => Promise<void> } {
  const [native, setNative] = useState(false);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [target]);

  const toggle = useCallback(async () => {
    const el = target.current;
    const action = nextFullscreenAction(document.fullscreenElement !== null, typeof el?.requestFullscreen === "function");
    if (action === "exit-native") {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (action === "enter-native" && el) {
      // a refused request (iframe policy, user gesture rules) falls back to the overlay
      await el.requestFullscreen().catch(() => setOverlay((o) => !o));
      return;
    }
    setOverlay((o) => !o);
  }, [target]);

  return { full: native || overlay, toggle };
}
