// Pure helpers behind the design-system components (tested in logic.test.ts; no React, no DOM).

/** Rows to render for a virtualised list: [start, end) plus spacer heights. Fixed row height. */
export function virtualWindow(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = 6) {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 2 * overscan;
  const start = Math.min(first, count);
  const end = Math.min(count, start + visible);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** Lists longer than this are virtualised (FRONTEND_TRADE_PLAN §3: "virtual rows over ~100"). */
export const VIRTUALIZE_ABOVE = 100;

export type TickDirection = "up" | "down" | "none";
/** Direction of a value change, for the tick flash. First render (prev undefined) never flashes. */
export function tickDirection(prev: bigint | undefined, next: bigint): TickDirection {
  if (prev === undefined || prev === next) return "none";
  return next > prev ? "up" : "down";
}

/** Roving-tabindex key handling for a horizontal tab list (WAI-ARIA tabs pattern). */
export function nextTabIndex(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** Sign glyph so direction never relies on colour alone (§3 accessibility). */
export const signGlyph = (v: bigint): string => (v > 0n ? "+" : v < 0n ? "−" : "");
