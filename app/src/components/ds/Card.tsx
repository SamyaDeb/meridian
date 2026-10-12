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

/** A panel: darker than the page, hairline border, 8 px corners (Hyperliquid). */
export function Card({ title, right, header, children, className = "", bodyClassName = "", variant = "card", scroll = false, as = "section", ...rest }: CardProps) {
  const Tag = as;
  // a padding-less card (className "p-0!") puts its tab header flush with the edges
  const flush = className.includes("p-0!");
  const shell =
    variant === "card"
      ? "rounded-card border border-border bg-card card-elev p-4"
      : "rounded-inner border border-border bg-card-2/60 p-3";
  const hasHeader = header !== undefined || title !== undefined || right !== undefined;
  return (
    <Tag className={`${shell} ${scroll ? "flex min-h-0 flex-col" : ""} ${className}`} aria-label={rest["aria-label"]}>
      {hasHeader && (
        // a tab header (Hyperliquid) runs edge to edge on a hairline; a plain title is a simple row
        <div className={header !== undefined ? `${flush ? "" : "-mx-4 -mt-4 mb-3 px-4"} flex min-h-10 items-end justify-between gap-2 border-b border-border` : "mb-3 flex min-h-8 items-center justify-between gap-2"}>
          {header ?? <h2 className="truncate text-[15px] text-text">{title}</h2>}
          {right}
        </div>
      )}
      {/* a scrolling body must be reachable by keyboard (axe scrollable-region-focusable) */}
      <div tabIndex={scroll ? 0 : undefined} className={`${scroll ? "min-h-0 flex-1 overflow-auto rounded-control" : ""} ${bodyClassName}`}>
        {children}
      </div>
    </Tag>
  );
}
