"use client";
import { useState, type ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { VIRTUALIZE_ABOVE, virtualWindow } from "./logic";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** CSS grid track, e.g. "minmax(0,1fr)" or "96px". Default minmax(0,1fr). */
  width?: string;
};

/**
 * Dense table with a sticky header. Rows are a CSS grid (ARIA table roles), so past VIRTUALIZE_ABOVE rows only the
 * visible window is mounted. Fixed row height is required for virtualisation.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  rowHeight = 36,
  maxHeight = 320,
  minWidth = 0,
  virtualizeAbove = VIRTUALIZE_ABOVE,
  className = "",
}: {
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string;
  /** Accessible name of the table (visually hidden). */
  caption: string;
  empty?: ReactNode;
  rowHeight?: number;
  maxHeight?: number;
  /** Horizontal scroll inside the card below this width instead of squeezing columns. */
  minWidth?: number;
  virtualizeAbove?: number;
  className?: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const template = columns.map((c) => c.width ?? "minmax(0,1fr)").join(" ");
  const list = rows ?? [];
  const virtual = list.length > virtualizeAbove;
  const win = virtual ? virtualWindow(scrollTop, maxHeight, rowHeight, list.length) : { start: 0, end: list.length, padTop: 0, padBottom: 0 };
  const align = (c: Column<T>) => (c.align === "right" ? "justify-end text-right" : "justify-start text-left");

  if (rows !== undefined && list.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  return (
    <div
      role="table"
      aria-label={caption}
      aria-rowcount={list.length + 1}
      aria-busy={rows === undefined || undefined}
      // scrollable regions must be reachable by keyboard (axe scrollable-region-focusable)
      tabIndex={0}
      className={`overflow-auto rounded-control ${className}`}
      style={{ maxHeight }}
      onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <div style={{ minWidth }}>
        <div role="rowgroup" className="sticky top-0 z-10 bg-card">
          <div role="row" aria-rowindex={1} className="grid items-center gap-3 border-b border-border px-2 py-2 text-xs text-muted" style={{ gridTemplateColumns: template }}>
            {columns.map((c) => (
              <div role="columnheader" key={c.key} className={`flex truncate ${align(c)}`}>
                {c.header}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup" style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
          {list.slice(win.start, win.end).map((r, i) => (
            <div
              role="row"
              key={rowKey(r)}
              aria-rowindex={win.start + i + 2}
              className="grid items-center gap-3 px-2 text-[13px] hover:bg-card-2/70"
              style={{ gridTemplateColumns: template, height: rowHeight }}
            >
              {columns.map((c) => (
                <div role="cell" key={c.key} className={`flex min-w-0 truncate ${align(c)}`}>
                  {c.cell(r)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
