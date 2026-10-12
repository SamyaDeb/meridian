/**
 * Page background: deep violet with two families of faint contour lines (Hyperliquid's wave backdrop, in Monad violet).
 * Pure SVG, fixed behind everything, never interactive. Colours come from tokens (globals.css `.app-bg`).
 */
const W = 1600;
const H = 1000;

// one family sweeps up from the bottom-left, the other falls in from the top-right; offsets fan the lines out
const lowLeft = Array.from({ length: 22 }, (_, i) => {
  const d = i * 26;
  return `M -200 ${620 + d} C 200 ${380 + d * 0.6}, 520 ${1020 + d * 0.4}, 900 ${980 + d * 0.2} S 1500 ${700 + d}, 1800 ${1180 + d}`;
});
const highRight = Array.from({ length: 18 }, (_, i) => {
  const d = i * 30;
  return `M 700 ${-120 + d * 0.2} C 1000 ${180 + d * 0.5}, 1250 ${-60 + d}, 1850 ${340 + d * 0.8}`;
});

export function AppBackground() {
  return (
    <div className="app-bg" aria-hidden>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" fill="none">
        <g stroke="var(--muted)" strokeOpacity={0.06} strokeWidth={1}>
          {lowLeft.map((d, i) => (
            <path key={`l${i}`} d={d} />
          ))}
          {highRight.map((d, i) => (
            <path key={`r${i}`} d={d} />
          ))}
        </g>
      </svg>
    </div>
  );
}
