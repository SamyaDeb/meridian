// Trade-page hotkeys (FRONTEND_TRADE_PLAN §6.7). Pure mapping; the page applies the action.
export type HotkeyAction = { type: "side"; side: "long" | "short" } | { type: "kind"; kind: "market" | "limit" } | { type: "clear" } | { type: "palette" } | { type: "focusSize" };

/**
 * Key → action. Typing in an input / select / textarea / contenteditable never triggers a letter hotkey (Esc still
 * clears, ⌘K / Ctrl+K always opens the palette).
 */
export function hotkeyAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; targetTag?: string; editable?: boolean }): HotkeyAction | undefined {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return { type: "palette" };
  if (e.metaKey || e.ctrlKey || e.altKey) return undefined;
  const typing = e.editable || ["INPUT", "SELECT", "TEXTAREA"].includes((e.targetTag ?? "").toUpperCase());
  if (e.key === "Escape") return typing ? undefined : { type: "clear" };
  if (typing) return undefined;
  switch (e.key.toLowerCase()) {
    case "b":
      return { type: "side", side: "long" };
    case "s":
      return { type: "side", side: "short" };
    case "m":
      return { type: "kind", kind: "market" };
    case "l":
      return { type: "kind", kind: "limit" };
    case "/":
      return { type: "focusSize" };
    default:
      return undefined;
  }
}

export const HOTKEY_HELP: readonly [string, string][] = [
  ["B / S", "Long / short"],
  ["M / L", "Market / limit"],
  ["/", "Focus size"],
  ["Esc", "Clear the draft"],
  ["⌘K / Ctrl K", "Command palette"],
];
