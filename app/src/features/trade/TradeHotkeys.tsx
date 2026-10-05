"use client";
import { useEffect } from "react";
import { hotkeyAction } from "@/lib/hotkeys";
import { getPrefs } from "@/lib/prefs";
import { clearDraft, setDraft } from "./draft";

/** Trade-page hotkeys (B/S, M/L, /, Esc). ⌘K is the global palette's. Off when the viewer disables hotkeys. */
export function TradeHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!getPrefs().hotkeys || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const a = hotkeyAction({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, targetTag: t?.tagName, editable: t?.isContentEditable });
      if (!a || a.type === "palette") return;
      // a modal (dialog) owns the keyboard while open
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (a.type === "side") setDraft({ side: a.side });
      else if (a.type === "kind") setDraft({ kind: a.kind });
      else if (a.type === "clear") clearDraft();
      else if (a.type === "focusSize") document.getElementById("size-in")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
