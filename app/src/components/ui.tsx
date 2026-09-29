import type { ReactNode } from "react";

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

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

export function Skeleton({ className = "h-5 w-24" }: { className?: string }) {
  return <span className={`inline-block animate-pulse rounded bg-surface-2 ${className}`} />;
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
