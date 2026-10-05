import type { ReactNode } from "react";

/** Honest empty state: says what is missing and, if possible, the one action that fills it. */
export function EmptyState({ title, body, action, icon, className = "" }: { title: ReactNode; body?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-4 py-8 text-center ${className}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-card-2 text-muted" aria-hidden>
        {icon ?? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <path d="M4 7h16M4 12h10M4 17h7" />
          </svg>
        )}
      </div>
      <p className="text-sm font-medium text-text">{title}</p>
      {body && <p className="max-w-xs text-xs text-muted">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
