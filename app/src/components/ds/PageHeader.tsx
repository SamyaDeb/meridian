import type { ReactNode } from "react";

/**
 * Page title row (Hyperliquid): a large light-weight title, an optional paragraph under it, and the page's actions on
 * the right (outlined buttons, the primary one filled).
 */
export function PageHeader({ title, description, actions, className = "" }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={`flex flex-col gap-4 px-1 pb-2 pt-1 lg:flex-row lg:items-start lg:justify-between lg:gap-8 lg:px-0 lg:pb-6 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[28px] font-normal leading-tight tracking-tight lg:text-[44px]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text/90 lg:mt-3 lg:text-[15px]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end lg:pt-2">{actions}</div>}
    </header>
  );
}

/** Big-number panel (Hyperliquid's "Your Total Supplied"): muted label, large value, optional link or note under it. */
export function StatCard({ label, value, sub, right, className = "" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-border bg-card card-elev px-4 py-3 lg:p-5 ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm text-muted lg:text-[15px]">{label}</div>
        {right}
      </div>
      <div className="num mt-1 truncate text-2xl font-normal tracking-tight lg:mt-3 lg:text-[34px]">{value}</div>
      {sub && <div className="mt-1 text-sm lg:mt-3">{sub}</div>}
    </div>
  );
}
