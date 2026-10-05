"use client";
import { useId, type ReactNode } from "react";

/** Hover / focus tooltip, CSS only. The trigger must be focusable (it gets aria-describedby). */
export function Tooltip({ content, children, side = "top", className = "" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom"; className?: string }) {
  const id = useId();
  return (
    <span className={`group/tt relative inline-flex ${className}`}>
      <span aria-describedby={id} tabIndex={0} className="inline-flex rounded-control">
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none invisible absolute left-1/2 z-40 w-max max-w-64 -translate-x-1/2 rounded-control border border-border bg-card-2 px-2.5 py-1.5 text-[11px] text-text opacity-0 transition-opacity group-focus-within/tt:visible group-focus-within/tt:opacity-100 group-hover/tt:visible group-hover/tt:opacity-100 ${side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
      >
        {content}
      </span>
    </span>
  );
}
