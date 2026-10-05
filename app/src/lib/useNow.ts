"use client";
import { useEffect, useState } from "react";

/** Wall-clock ms, refreshed every `everyMs` (keeps Date.now() out of render). 0 until mounted. */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, everyMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [everyMs]);
  return now;
}
