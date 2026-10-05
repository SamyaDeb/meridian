"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Modal on the native <dialog> (focus trap, Esc, inert background for free). Bottom sheet on phones, centred card above.
 * `onClose` fires on Esc, backdrop click and the close button; the parent owns `open`. Mark the field that should take
 * focus on open with `data-autofocus` (React's autoFocus runs before showModal moves focus).
 */
export function Dialog({ open, onClose, title, children, footer, className = "" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal focuses the first focusable (the close button); a field marked data-autofocus takes precedence
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop
      }}
      className={`m-0 mt-auto w-full max-w-none bg-transparent p-0 text-text backdrop:bg-black/60 sm:m-auto sm:max-w-md ${className}`}
    >
      {open && (
        <div className="max-h-[85dvh] overflow-y-auto rounded-t-card border border-border bg-card p-4 pb-[calc(16px+env(safe-area-inset-bottom))] card-elev sm:rounded-card">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-card-2 hover:text-text pointer-coarse:h-11 pointer-coarse:w-11">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          {children}
          {footer && <div className="mt-4 flex gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
