import type { CSSProperties } from "react";

// Odometer-style number: each digit is a column of 0-9 (looped once) that
// useLandingAnimations scrolls into place. Rests on the final digit by default.
export default function RollNumber({ n, style }: { n: number; style?: CSSProperties }) {
  const digits = String(n).split("");
  return (
    <span data-roll={n} style={style} aria-label={String(n)}>
      {digits.map((d, di) => {
        const len = 10 + Number(d);
        return (
          <span key={di} aria-hidden="true" style={{ display: "inline-block", height: "1em", lineHeight: 1, overflow: "hidden" }}>
            <span data-roll-col={len} data-di={di} style={{ display: "flex", flexDirection: "column", transform: `translateY(-${len}em)` }}>
              {Array.from({ length: len + 1 }, (_, k) => (
                <span key={k} style={{ height: "1em", lineHeight: 1 }}>
                  {k % 10}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
