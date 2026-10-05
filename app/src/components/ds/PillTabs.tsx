"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextTabIndex } from "./logic";

export type PillTab<T extends string> = { id: T; label: ReactNode; count?: number; disabled?: boolean };

/**
 * Pill tab list (WAI-ARIA tabs: roving tabindex, arrows / Home / End). Active tab = brand pill.
 * Pass `panelIdPrefix` when the tabs control panels (each panel gets id `${prefix}-${tab.id}`).
 */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className = "",
  panelIdPrefix,
}: {
  tabs: readonly PillTab<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
  panelIdPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const uid = useId();
  const current = Math.max(0, tabs.findIndex((t) => t.id === value));
  const onKey = (e: KeyboardEvent) => {
    let i = nextTabIndex(e.key, current, tabs.length);
    if (i === undefined) return;
    e.preventDefault();
    for (let n = 0; n < tabs.length && tabs[i]?.disabled; n++) i = nextTabIndex(e.key === "Home" ? "ArrowRight" : e.key === "End" ? "ArrowLeft" : e.key, i, tabs.length) ?? i;
    const t = tabs[i];
    if (!t || t.disabled) return;
    onChange(t.id);
    refs.current[i]?.focus();
  };
  const h = size === "sm" ? "h-7 px-3 text-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11 justify-center" : "min-h-9 px-3.5 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 justify-center";
  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKey} className={`inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-card-2 p-1 ${className}`}>
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${uid}-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelIdPrefix ? `${panelIdPrefix}-${t.id}` : undefined}
            tabIndex={active ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors disabled:opacity-40 ${h} ${active ? "bg-brand text-on-brand" : "text-muted hover:text-text"}`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`num rounded-full px-1.5 text-[10px] ${active ? "bg-on-brand/15" : "bg-card"}`}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
