"use client";
import { useState } from "react";
import { loadDrawings, saveDrawings, type Drawing, type Tool } from "./model";

/** Drawing state for one market: shapes (persisted per viewer), active tool, magnet, erase, lock. */
export function useDrawings(market: string) {
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  if (loadedFor !== market && typeof window !== "undefined") {
    setLoadedFor(market);
    setDrawings(loadDrawings(market));
  }
  const [tool, setTool] = useState<Tool | null>(null);
  const [magnetOn, setMagnet] = useState(true);
  const [erase, setErase] = useState(false);
  const [locked, setLocked] = useState(false);
  const commit = (next: Drawing[]) => {
    setDrawings(next);
    saveDrawings(market, next);
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
  };
}
export type DrawingsApi = ReturnType<typeof useDrawings>;
