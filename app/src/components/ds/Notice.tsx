import type { ReactNode } from "react";

export type NoticeTone = "info" | "brand" | "warn" | "danger";

const TONE: Record<NoticeTone, string> = {
  info: "border-border bg-card-2 text-muted",
  brand: "border-brand/30 bg-brand-tint text-brand-soft",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-short/30 bg-short/10 text-short",
};

/** Rounded banner for test-market, mock-data, not-deployed, stale and error states. Always a live region. */
export function Notice({ tone = "info", title, children, action, className = "" }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start justify-between gap-3 rounded-inner border px-3 py-2.5 text-xs ${TONE[tone]} ${className}`}>
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
