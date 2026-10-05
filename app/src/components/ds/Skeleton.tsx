/** Loading placeholder. Prefer same-metric text placeholders for LCP elements (see Trade price). */
export function Skeleton({ className = "h-5 w-24", label = "Loading" }: { className?: string; label?: string }) {
  return <span role="status" aria-label={label} className={`inline-block animate-pulse rounded-control bg-card-2 ${className}`} />;
}
