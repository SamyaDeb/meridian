import type { ReactNode } from "react";

export type ChipTone = "neutral" | "brand" | "long" | "short" | "warn";

const TONE: Record<ChipTone, string> = {
  neutral: "border-line text-muted",
  brand: "border-brand-soft/40 bg-brand-tint text-brand-soft",
  long: "border-long/40 bg-long/10 text-long",
  short: "border-short/40 bg-short/10 text-short",
  warn: "border-warn/40 bg-warn/10 text-warn",
};

/** Small status pill (network, test market, stale, oracle APR). */
export function Chip({ tone = "neutral", dot = false, pulse = false, children, className = "", title }: { tone?: ChipTone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border px-2 py-0.5 text-[11px] font-medium ${TONE[tone]} ${className}`}>
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
