"use client";
// Meridian chart tool rail (left edge, Monad theme): cursor, grouped drawing tools (last used tool per group, flyout for the
// rest), measure, zoom, then magnet / lock / erase / clear. Drawings are a local planning aid; position plans are
// labelled "not an order".
import { useState, type ReactNode } from "react";
import type { Tool } from "../drawings/model";
import { TOOL_LABEL } from "../drawings/model";
import type { DrawingsApi } from "../drawings/useDrawings";
import { I } from "./icons";

const TOOL_ICON: Record<Tool, ReactNode> = { trend: I.trend, ray: I.ray, hline: I.hline, vline: I.vline, fib: I.fib, rect: I.rect, brush: I.brush, text: I.text, long: I.long, short: I.short, ruler: I.ruler };
const GROUPS: { id: string; label: string; tools: Tool[] }[] = [
  { id: "lines", label: "Lines", tools: ["trend", "ray", "hline", "vline"] },
  { id: "fib", label: "Fibonacci", tools: ["fib"] },
  { id: "shapes", label: "Shapes", tools: ["rect", "brush"] },
  { id: "text", label: "Text", tools: ["text"] },
  { id: "position", label: "Position planner (not an order)", tools: ["long", "short"] },
];

const cell = (on: boolean) => `relative grid h-9 w-9 pointer-coarse:h-11 pointer-coarse:w-11 place-items-center rounded-[8px] transition-colors pointer-coarse:h-11 pointer-coarse:w-11 ${on ? "bg-card-2 text-text" : "text-muted hover:bg-card-2 hover:text-text"} disabled:opacity-35`;

export function ToolRail({ api, onZoomIn }: { api: DrawingsApi; onZoomIn: () => void }) {
  const [current, setCurrent] = useState<Record<string, Tool>>(() => Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]!])));
  const [open, setOpen] = useState<string | null>(null);
  // the rail scrolls vertically (which clips sideways overflow), so flyouts are positioned against the viewport
  const [at, setAt] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const pick = (gid: string, t: Tool) => {
    setCurrent((c) => ({ ...c, [gid]: t }));
    api.setTool(api.tool === t ? null : t);
    setOpen(null);
  };
  return (
    <div role="toolbar" aria-label="Drawing tools" aria-orientation="vertical" className="flex w-14 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border py-2 max-sm:hidden">
      <button type="button" aria-label="Crosshair (no drawing tool)" title="Crosshair" aria-pressed={!api.tool && !api.erase} onClick={() => (api.setTool(null), api.setErase(false))} className={cell(!api.tool && !api.erase)}>
        {I.cross}
      </button>
      {GROUPS.map((g) => {
        const t = current[g.id]!;
        const active = g.tools.includes(api.tool as Tool);
        return (
          <div key={g.id} className="relative">
            <button type="button" aria-label={TOOL_LABEL[active ? (api.tool as Tool) : t]} title={TOOL_LABEL[active ? (api.tool as Tool) : t]} aria-pressed={active} onClick={() => pick(g.id, active ? (api.tool as Tool) : t)} className={cell(active)}>
              {TOOL_ICON[active ? (api.tool as Tool) : t]}
            </button>
            {g.tools.length > 1 && (
              <button
                type="button"
                aria-label={`More ${g.label}`}
                aria-expanded={open === g.id}
                onClick={(e) => {
                  const r = e.currentTarget.parentElement!.getBoundingClientRect();
                  setAt({ left: r.right + 6, top: r.top });
                  setOpen(open === g.id ? null : g.id);
                }} className="absolute -right-0.5 bottom-0 grid h-3.5 w-3.5 place-items-center text-muted hover:text-text pointer-coarse:h-6 pointer-coarse:w-6">
                <svg viewBox="0 0 8 8" width={7} height={7} aria-hidden>
                  <path d="M8 2v6H2z" fill="currentColor" />
                </svg>
              </button>
            )}
            {open === g.id && (
              <div style={{ position: "fixed", left: at.left, top: at.top }} className="z-50 w-56 rounded-inner border border-border bg-card p-1 card-elev">
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted">{g.label}</p>
                {g.tools.map((x) => (
                  <button key={x} type="button" aria-label={TOOL_LABEL[x]} onClick={() => pick(g.id, x)} className={`flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] pointer-coarse:min-h-11 ${api.tool === x ? "bg-brand-tint text-brand-soft" : "hover:bg-card-2"}`}>
                    {TOOL_ICON[x]}
                    {TOOL_LABEL[x]}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <span className="my-1 h-px w-7 bg-border" aria-hidden />
      <button type="button" aria-label={TOOL_LABEL.ruler} title={TOOL_LABEL.ruler} aria-pressed={api.tool === "ruler"} onClick={() => api.setTool(api.tool === "ruler" ? null : "ruler")} className={cell(api.tool === "ruler")}>
        {I.ruler}
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn} className={cell(false)}>
        {I.zoomIn}
      </button>
      <span className="my-1 h-px w-7 bg-border" aria-hidden />
      <button type="button" aria-pressed={api.magnet} aria-label="Magnet: snap to OHLC" title="Magnet: snap to OHLC" onClick={() => api.setMagnet(!api.magnet)} className={cell(api.magnet)}>
        {I.magnet}
      </button>
      {/* lock / erase / clear share one flyout, below the fold of the rail */}
      <div className="relative">
        <button
          type="button"
          aria-label="Manage drawings"
          aria-expanded={open === "manage"}
          title="Lock, erase, clear"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ left: r.right + 6, top: Math.max(8, r.top - 96) });
            setOpen(open === "manage" ? null : "manage");
          }}
          className={cell(api.locked || api.erase)}
        >
          {api.locked ? I.lock : api.erase ? I.erase : I.trash}
        </button>
        {open === "manage" && (
          <div style={{ position: "fixed", left: at.left, top: at.top }} className="z-50 w-60 rounded-inner border border-border bg-card p-1 card-elev">
            <button type="button" aria-pressed={api.locked} aria-label="Lock drawings" disabled={api.drawings.length === 0} onClick={() => api.setLocked(!api.locked)} className="flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] hover:bg-card-2 disabled:opacity-40 pointer-coarse:min-h-11">
              {api.locked ? I.lock : I.unlock}
              {api.locked ? "Unlock drawings" : "Lock drawings"}
            </button>
            <button type="button" aria-pressed={api.erase} aria-label="Erase: click a drawing to delete it" disabled={api.locked || api.drawings.length === 0} onClick={() => (api.setErase(!api.erase), setOpen(null))} className="flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] hover:bg-card-2 disabled:opacity-40 pointer-coarse:min-h-11">
              {I.erase}
              Erase (click a drawing)
            </button>
            <button type="button" aria-label="Clear all drawings" disabled={api.locked || api.drawings.length === 0} onClick={() => (api.clear(), setOpen(null))} className="flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-short hover:bg-card-2 disabled:opacity-40 pointer-coarse:min-h-11">
              {I.trash}
              Clear all drawings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
