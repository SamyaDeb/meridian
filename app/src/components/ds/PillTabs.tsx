"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextTabIndex } from "./logic";

export type PillTab<T extends string> = { id: T; label: ReactNode; count?: number; disabled?: boolean };

/**
 * Tab list (WAI-ARIA tabs: roving tabindex, arrows / Home / End). Hyperliquid style: plain labels on a hairline, the
 * active tab in full text colour with a light-accent underline. (Name kept from the pill era so call sites don't change.)
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
  fill = false,
}: {
  tabs: readonly PillTab<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
  panelIdPrefix?: string;
  /** Tabs share the full width equally, label centred under a full-width underline (Hyperliquid's book / ticket tabs). */
  fill?: boolean;
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
  const h = size === "sm" ? "h-8 text-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11 justify-center" : "h-10 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 justify-center";
  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKey} className={`${fill ? "flex w-full" : `inline-flex max-w-full ${size === "sm" ? "gap-4" : "gap-5"}`} items-end overflow-x-auto ${className}`}>
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
            className={`-mb-px inline-flex ${fill ? "min-w-0 flex-1" : "shrink-0"} items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 transition-colors disabled:opacity-40 ${h} ${active ? "border-brand-soft text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`num rounded-control px-1 text-[10px] ${active ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted"}`}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
