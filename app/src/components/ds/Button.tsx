import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "brand" | "outline" | "long" | "short" | "ghost" | "secondary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // filled: the one primary action on a surface
  brand: "border border-brand bg-brand text-on-brand hover:border-brand-hover hover:bg-brand-hover font-medium",
  // outlined in the light accent: secondary actions in page headers and rows (Hyperliquid's Withdraw / Send buttons)
  outline: "border border-brand-soft/45 bg-transparent text-brand-soft hover:border-brand-soft/80 hover:bg-brand-soft/10 font-medium",
  long: "border border-long bg-long text-on-brand hover:brightness-110 font-medium",
  short: "border border-short bg-short text-on-brand hover:brightness-110 font-medium",
  secondary: "border border-line bg-card-2 text-text hover:border-brand-soft/50",
  ghost: "border border-transparent bg-transparent text-muted hover:bg-card-2 hover:text-text",
  danger: "border border-short/45 bg-transparent text-short hover:border-short/80 hover:bg-short/10",
};

// md and lg are ≥ 44 px everywhere; sm is dense on desktop and grows to 44 px on touch screens (§3).
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs pointer-coarse:min-h-11",
  md: "min-h-10 px-4 text-sm pointer-coarse:min-h-11",
  lg: "min-h-12 px-6 text-[15px]",
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
      className={`inline-flex items-center justify-center gap-2 rounded-control transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]} ${block ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}
