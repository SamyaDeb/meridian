"use client";
import { useState } from "react";
import { loadDrawings, saveDrawings, type Drawing, type Tool } from "./model";

/** Drawing state for one market: shapes (persisted per viewer), active tool, magnet, erase, lock. */
export function useDrawings(market: string) {
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [past, setPast] = useState<Drawing[][]>([]);
  const [future, setFuture] = useState<Drawing[][]>([]);
  if (loadedFor !== market && typeof window !== "undefined") {
    setLoadedFor(market);
    setDrawings(loadDrawings(market));
    setPast([]);
    setFuture([]);
  }
  const [tool, setTool] = useState<Tool | null>(null);
  const [magnetOn, setMagnet] = useState(true);
  const [erase, setErase] = useState(false);
  const [locked, setLocked] = useState(false);
  // undo / redo of drawing changes (add, erase, clear), bounded; reset when the market changes
  const apply = (next: Drawing[]) => {
    setDrawings(next);
    saveDrawings(market, next);
  };
  const commit = (next: Drawing[]) => {
    setPast((p) => [...p.slice(-49), drawings]);
    setFuture([]);
    apply(next);
  };
  return {
    drawings,
    tool,
    setTool: (t: Tool | null) => {
      setTool(t);
      if (t) setErase(false);
    },
    magnet: magnetOn,
    setMagnet,
    erase,
    setErase: (v: boolean) => {
      setErase(v);
      if (v) setTool(null);
    },
    locked,
    setLocked,
    add: (d: Drawing) => commit([...drawings, d]),
    remove: (id: string) => !locked && commit(drawings.filter((d) => d.id !== id)),
    clear: () => !locked && commit([]),
    canUndo: past.length > 0 && !locked,
    canRedo: future.length > 0 && !locked,
    undo: () => {
      const prev = past[past.length - 1];
      if (!prev || locked) return;
      setPast(past.slice(0, -1));
      setFuture((f) => [...f, drawings]);
      apply(prev);
    },
    redo: () => {
      const next = future[future.length - 1];
      if (!next || locked) return;
      setFuture(future.slice(0, -1));
      setPast((p) => [...p, drawings]);
      apply(next);
    },
  };
}
export type DrawingsApi = ReturnType<typeof useDrawings>;
