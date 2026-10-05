import type { ReactNode } from "react";

// Card and Skeleton live in the design system now; re-exported so existing screens keep their imports.
export { Card, Skeleton } from "./ds";

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "long" | "short" | "warn" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num truncate text-base font-medium ${color}`}>{value}</div>
      {sub && <div className="num text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Row({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "long" | "short" | "warn" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted">{label}</span>
      <span className={`num ${color}`}>{value}</span>
    </div>
  );
}

export const toneOf = (x: bigint): "long" | "short" | undefined => (x > 0n ? "long" : x < 0n ? "short" : undefined);

/** Display-only sparkline (floats are fine here: no money math). */
export function Sparkline({ values, className = "h-12 w-full", stroke = "var(--accent)" }: { values: number[]; className?: string; stroke?: string }) {
  if (values.length < 2) return <div className={className} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(28 - ((v - min) / span) * 26).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className} aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
