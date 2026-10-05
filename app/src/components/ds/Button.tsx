import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "brand" | "long" | "short" | "ghost" | "secondary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  brand: "bg-brand text-on-brand hover:bg-brand-hover font-semibold",
  long: "bg-long text-on-brand hover:brightness-110 font-semibold",
  short: "bg-short text-on-brand hover:brightness-110 font-semibold",
  secondary: "bg-card-2 text-text hover:bg-border",
  ghost: "bg-transparent text-muted hover:bg-card-2 hover:text-text",
  danger: "bg-short/15 text-short hover:bg-short/25",
};

// md and lg are ≥ 44 px everywhere; sm is dense on desktop and grows to 44 px on touch screens (§3).
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs pointer-coarse:min-h-11",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-5 text-base",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  block = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean; block?: boolean; children: ReactNode }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-control transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${block ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}
