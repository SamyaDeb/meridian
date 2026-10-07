"use client";
import { useEffect, useRef, useState } from "react";
import type { MfiPoint } from "@/data/mfi";
import { SERIES, aprPct, fmtPct, fmtTime, lineModel, nearestIndex } from "./model";

const H = 200;

/** MFI vs its venues, one axis (APR %), crosshair tooltip, legend + end labels, table view. `series` limits the lines
 *  (the Rates page's indexer card shows Meridian vs Perpl only). */
export function MfiChart({ points, series = SERIES }: { points: MfiPoint[]; series?: typeof SERIES }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(358);
  const [hover, setHover] = useState<number | undefined>();
  const [table, setTable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const m = lineModel(points, w, H);
  const hp = hover !== undefined ? points[hover] : undefined;
  return (
    <div ref={ref} className="viz">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {/* the legend is hidden from assistive tech in table view (the table has its own headers); the toggle never is */}
        <span className="contents" aria-hidden={table}>
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden>
                <rect width="14" height="4" rx="2" fill={s.color} />
              </svg>
              {s.label}
            </span>
          ))}
        </span>
        <button type="button" aria-pressed={table} onClick={() => setTable((v) => !v)} className="ml-auto inline-flex min-h-11 items-center underline">
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table || !m ? (
        <MfiTable points={points} series={series} />
      ) : (
        <svg
          width={w}
          height={H}
          role="img"
          aria-label={`Funding APR over time: MFI, Meridian and Perpl. Latest MFI ${m.last.mfi ? fmtPct(m.last.mfi.pct) : "n/a"}.`}
          onPointerMove={(e) => setHover(nearestIndex(points, m, e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setHover(undefined)}
          className="touch-pan-y"
        >
          {m.yTicks.map((t) => (
            <g key={t}>
              <line x1={44} x2={w - 12} y1={m.y(t)} y2={m.y(t)} stroke="var(--viz-grid)" strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={38} y={m.y(t) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px]">{`${t}%`}</text>
            </g>
          ))}
          {m.xTicks.map((t, i) => (
            <text key={t} x={m.x(t)} y={H - 4} textAnchor={i === 0 ? "start" : i === m.xTicks.length - 1 ? "end" : "middle"} className="fill-[var(--muted)] text-[11px]">
              {fmtTime(t)}
            </text>
          ))}
          {/* venues first, the index last so it stays on top where it overlaps a heavily weighted venue */}
          {[...series].reverse().map((s) => (
            <path key={s.key} d={m.paths[s.key]} fill="none" stroke={s.color} strokeWidth={s.key === "mfi" ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hp && (
            <g>
              <line x1={m.x(hp.t)} x2={m.x(hp.t)} y1={10} y2={H - 22} stroke="var(--muted)" strokeWidth={1} />
              {series.map((s) => {
                const v = hp[s.key];
                return v === null ? null : <circle key={s.key} cx={m.x(hp.t)} cy={m.y(aprPct(v))} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
      )}
      {hp && !table && (
        <div role="status" className="num mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
          <span>{fmtTime(hp.t)}</span>
          {series.map((s) => (
            <span key={s.key}>
              {s.label} <span className="text-text">{hp[s.key] === null ? "n/a" : fmtPct(aprPct(hp[s.key]!))}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function MfiTable({ points, series = SERIES }: { points: MfiPoint[]; series?: typeof SERIES }) {
  const rows = points.slice(-12).reverse();
  return (
    <table className="num w-full text-left text-xs">
      <caption className="sr-only">Funding APR, latest 12 points</caption>
      <thead className="text-muted">
        <tr>
          <th scope="col" className="py-1 font-normal">Time</th>
          {series.map((s) => (
            <th key={s.key} scope="col" className="py-1 text-right font-normal">{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.t} className="border-t border-border">
            <td className="py-1 text-muted">{fmtTime(p.t)}</td>
            {series.map((s) => (
              <td key={s.key} className="py-1 text-right">{p[s.key] === null ? "n/a" : fmtPct(aprPct(p[s.key]!))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
