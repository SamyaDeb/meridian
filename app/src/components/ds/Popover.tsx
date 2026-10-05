"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Button + floating panel (account menu, notifications). Closes on Esc (focus returns to the trigger) and on an
 * outside click. The panel is a labelled region; menus inside use plain buttons/links (no ARIA menu role needed).
 */
export function Popover({
  label,
  trigger,
  children,
  align = "end",
  triggerClassName = "",
  panelClassName = "",
  fixed = false,
}: {
  /** Accessible name of the trigger and the panel. */
  label: string;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  triggerClassName?: string;
  panelClassName?: string;
  /** Position the panel against the viewport (inside clipping containers such as table cells). */
  fixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={root} className="relative">
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (fixed && btn.current) {
            const r = btn.current.getBoundingClientRect();
            // open downwards when there is room for a typical panel, else flip above the trigger
            const below = window.innerHeight - r.bottom;
            const right = Math.max(8, window.innerWidth - r.right);
            setPos(below >= 320 || below >= r.top ? { top: r.bottom + 8, right } : { bottom: window.innerHeight - r.top + 8, right });
          }
          setOpen((o) => !o);
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="region"
          aria-label={label}
          style={fixed && pos ? { position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" } : undefined}
          className={`z-50 w-72 max-w-[calc(100vw-16px)] rounded-inner border border-border bg-card p-2 whitespace-normal card-elev ${fixed ? "" : `absolute top-full mt-2 ${align === "end" ? "right-0" : "left-0"}`} ${panelClassName}`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
