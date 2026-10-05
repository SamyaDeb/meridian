"use client";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Drag handle between terminal cards (WAI-ARIA window splitter: role=separator, arrow keys ±16 px, Shift ±64,
 * Home / End to the bounds). `grow` is the sign that turns pointer movement into a bigger value.
 */
export function Splitter({ orientation, value, min, max, onChange, label, grow, className = "" }: { orientation: "vertical" | "horizontal"; value: number; min: number; max: number; onChange: (v: number) => void; label: string; grow: 1 | -1; className?: string }) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const axis = (e: PointerEvent) => (orientation === "vertical" ? e.clientX : e.clientY);
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const inc: Record<string, number> = orientation === "vertical" ? { ArrowLeft: -grow * step, ArrowRight: grow * step } : { ArrowUp: -grow * step, ArrowDown: grow * step };
    const d = inc[e.key];
    if (d !== undefined) {
      e.preventDefault();
      onChange(value + d);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(max);
    }
  };
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: axis(e), value };
      }}
      onPointerMove={(e) => {
        if (start.current) onChange(start.current.value + grow * (axis(e) - start.current.pos));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      className={`group absolute z-20 hidden touch-none select-none items-center justify-center xl:flex ${orientation === "vertical" ? "-left-[6px] top-0 h-full w-[10px] cursor-col-resize" : "-top-[6px] left-0 h-[10px] w-full cursor-row-resize"} ${className}`}
    >
      <span className={`rounded-full bg-border transition-colors group-hover:bg-brand group-focus-visible:bg-brand ${orientation === "vertical" ? "h-10 w-1" : "h-1 w-10"}`} aria-hidden />
    </div>
  );
}
