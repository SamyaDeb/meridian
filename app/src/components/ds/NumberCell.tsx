"use client";
import { useEffect, useRef, useState } from "react";
import { signGlyph, tickDirection, type TickDirection } from "./logic";

/**
 * A bigint shown through `format`, flashing green / red on change (respects reduced motion via globals.css).
 * `signed` adds +/− and colours by sign, so direction is never colour-only.
 */
export function NumberCell({
  value,
  format,
  signed = false,
  flash = true,
  className = "",
  suffix,
}: {
  value: bigint | undefined;
  format: (v: bigint) => string;
  signed?: boolean;
  flash?: boolean;
  className?: string;
  suffix?: string;
}) {
  const prev = useRef<bigint | undefined>(undefined);
  const [tick, setTick] = useState<{ dir: TickDirection; n: number }>({ dir: "none", n: 0 });
  useEffect(() => {
    if (value === undefined) return;
    const dir = tickDirection(prev.current, value);
    prev.current = value;
    if (flash && dir !== "none") setTick((t) => ({ dir, n: t.n + 1 }));
  }, [value, flash]);
  if (value === undefined) return <span className={`num text-muted ${className}`}>—</span>;
  const abs = value < 0n ? -value : value;
  // a value that rounds to zero at display precision shows as a neutral zero (never "−0.00" in red)
  const shownZero = !/[1-9]/.test(format(abs));
  const sign = signed && !shownZero ? signGlyph(value) : "";
  const tone = signed && !shownZero ? (value > 0n ? "text-long" : value < 0n ? "text-short" : "") : "";
  const anim = tick.dir === "up" ? "tick-up" : tick.dir === "down" ? "tick-down" : "";
  return (
    <span key={tick.n} className={`num rounded-[4px] ${tone} ${anim} ${className}`}>
      {signed ? sign + format(abs) : format(value)}
      {suffix && <span className="text-muted"> {suffix}</span>}
    </span>
  );
}
