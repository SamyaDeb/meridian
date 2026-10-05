import type { ReactNode } from "react";

type CardProps = {
  title?: ReactNode;
  /** Right side of the header: actions, chips. */
  right?: ReactNode;
  /** Replaces the title row entirely (e.g. PillTabs). */
  header?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** "card" = top-level panel (24 px); "inner" = well inside a card (16 px, darker). */
  variant?: "card" | "inner";
  /** Body scrolls inside the card instead of growing it (terminal panels). */
  scroll?: boolean;
  as?: "section" | "div" | "aside";
  "aria-label"?: string;
};

/** Every panel is a separate rounded card (FRONTEND_TRADE_PLAN §3). */
export function Card({ title, right, header, children, className = "", bodyClassName = "", variant = "card", scroll = false, as = "section", ...rest }: CardProps) {
  const Tag = as;
  const shell =
    variant === "card"
      ? "rounded-card border border-border bg-card card-elev p-4"
      : "rounded-inner bg-card-2 p-3";
  const hasHeader = header !== undefined || title !== undefined || right !== undefined;
  return (
    <Tag className={`${shell} ${scroll ? "flex min-h-0 flex-col" : ""} ${className}`} aria-label={rest["aria-label"]}>
      {hasHeader && (
        <div className="mb-3 flex min-h-8 items-center justify-between gap-2">
          {header ?? <h2 className="truncate text-sm font-medium text-muted">{title}</h2>}
          {right}
        </div>
      )}
      <div className={`${scroll ? "min-h-0 flex-1 overflow-auto" : ""} ${bodyClassName}`}>{children}</div>
    </Tag>
  );
}
