"use client";
import { Popover } from "@/components/ds";
import { HOTKEY_HELP } from "@/lib/hotkeys";
import { setPrefs, usePrefs, type Prefs } from "@/lib/prefs";

const ROWS: [keyof Prefs, string, string][] = [
  ["hidePnl", "Hide PnL", "Masks unrealized PnL and funding (screen sharing)"],
  ["hideLiq", "Hide liquidation price", "Masks liq. prices in tables, ticket and chart labels"],
  ["hideBalances", "Hide balances", "Masks equity, collateral and margin"],
  ["sound", "Sound on fills and errors", "A short tone with each transaction toast"],
  ["hotkeys", "Trade hotkeys", "B / S, M / L, / and Esc on the Trade page"],
];

/** Settings gear: privacy toggles, sound, hotkeys (each a real preference the UI reads). */
export function SettingsMenu() {
  const p = usePrefs();
  return (
    <Popover
      label="Settings"
      triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-control border border-line text-text hover:border-brand-soft/60 hover:text-brand-soft pointer-coarse:h-11 pointer-coarse:w-11"
      trigger={
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
          <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
        </svg>
      }
    >
      <div className="space-y-1 p-1">
        {ROWS.map(([k, label, hint]) => (
          <label key={k} className="flex min-h-10 cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 hover:bg-card-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={p[k]} onChange={(e) => setPrefs({ [k]: e.target.checked })} />
            <span>
              <span className="block text-xs">{label}</span>
              <span className="block text-[10px] text-muted">{hint}</span>
            </span>
          </label>
        ))}
        <div className="border-t border-border px-2 pt-2 text-[10px] text-muted">
          {HOTKEY_HELP.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="num">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}
