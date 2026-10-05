import type { ReactNode } from "react";

export type ChipTone = "neutral" | "brand" | "long" | "short" | "warn";

const TONE: Record<ChipTone, string> = {
  neutral: "bg-card-2 text-muted",
  brand: "bg-brand-tint text-brand-soft",
  long: "bg-long/15 text-long",
  short: "bg-short/15 text-short",
  warn: "bg-warn/15 text-warn",
};

/** Small status pill (network, test market, stale, oracle APR). */
export function Chip({ tone = "neutral", dot = false, pulse = false, children, className = "", title }: { tone?: ChipTone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TONE[tone]} ${className}`}>
      {dot && (
        <span className="relative inline-flex h-1.5 w-1.5" aria-hidden>
          {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  );
}
