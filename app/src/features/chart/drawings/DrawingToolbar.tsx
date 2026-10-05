"use client";
import { Popover } from "@/components/ds";
import { TOOL_LABEL, type Tool } from "./model";
import type { DrawingsApi } from "./useDrawings";

const TOOLS: Tool[] = ["hline", "vline", "trend", "ray", "rect", "fib", "text", "ruler", "brush", "long", "short"];
const chip = (on: boolean) => `h-7 rounded-full px-2.5 text-[11px] pointer-coarse:h-11 pointer-coarse:min-w-11 ${on ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted hover:text-text"}`;

/** Draw menu + magnet / erase / lock / clear. Drawings are a local planning aid: nothing here sends anything. */
export function DrawingToolbar({ api }: { api: DrawingsApi }) {
  return (
    <>
      <Popover label="Drawing tools" align="start" triggerClassName={chip(Boolean(api.tool))} trigger={api.tool ? `Draw · ${TOOL_LABEL[api.tool]}` : "Draw"}>
        {(close) => (
          <div className="grid grid-cols-1 gap-0.5 p-1">
            {TOOLS.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={api.tool === t}
                onClick={() => {
                  api.setTool(api.tool === t ? null : t);
                  close();
                }}
                className={`flex min-h-8 items-center rounded-control px-2 text-left text-xs pointer-coarse:min-h-11 ${api.tool === t ? "bg-brand-tint text-brand-soft" : "hover:bg-card-2"}`}
              >
                {TOOL_LABEL[t]}
              </button>
            ))}
            <p className="px-2 pt-1 text-[10px] text-muted">Drawings stay in this browser. Position plans are not orders.</p>
          </div>
        )}
      </Popover>
      <button type="button" aria-pressed={api.magnet} aria-label="Magnet: snap to OHLC" onClick={() => api.setMagnet(!api.magnet)} className={chip(api.magnet)}>
        Magnet
      </button>
      {api.drawings.length > 0 && (
        <>
          <button type="button" aria-pressed={api.erase} aria-label="Erase: click a drawing to delete it" disabled={api.locked} onClick={() => api.setErase(!api.erase)} className={`${chip(api.erase)} disabled:opacity-40`}>
            Erase
          </button>
          <button type="button" aria-pressed={api.locked} aria-label="Lock drawings" onClick={() => api.setLocked(!api.locked)} className={chip(api.locked)}>
            {api.locked ? "Locked" : "Lock"}
          </button>
          <button type="button" aria-label="Clear all drawings" disabled={api.locked} onClick={api.clear} className={`${chip(false)} disabled:opacity-40`}>
            Clear
          </button>
        </>
      )}
    </>
  );
}
