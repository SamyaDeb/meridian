"use client";
import type { ReactNode } from "react";
import { MASK, usePrefs } from "@/lib/prefs";

/** Shows `children` unless the viewer hid this kind of value (settings gear). */
export function Private({ kind, children }: { kind: "pnl" | "liq" | "balance"; children: ReactNode }) {
  const p = usePrefs();
  const hidden = kind === "pnl" ? p.hidePnl : kind === "liq" ? p.hideLiq : p.hideBalances;
  return hidden ? (
    <span className="num text-muted" aria-label="hidden">
      {MASK}
    </span>
  ) : (
    <>{children}</>
  );
}
