"use client";
import { useEffect, useState } from "react";
import { useMarket } from "@/data/hooks";
import { liveness, observeHead, type HeadState } from "@/lib/blocks";
import { formatFixed } from "@/lib/format";
import { Chip, Tooltip } from "@/components/ds";

/** Latest block from the data source with a pulse while blocks advance; "stale" when they stop (or reads fail). */
export function BlockCounter({ compact = false }: { compact?: boolean }) {
  const { data: m, isError } = useMarket();
  const [head, setHead] = useState<HeadState>(undefined);
  const [now, setNow] = useState(0);
  const latest = m?.lastFundingBlock;
  useEffect(() => {
    if (latest === undefined) return;
    const t = Date.now();
    queueMicrotask(() => {
      setHead((h) => observeHead(h, latest, t));
      setNow(t);
    });
  }, [latest]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const state = isError ? "stale" : liveness(head, now);
  const block = head ? `#${formatFixed(head.block, 0, 0)}` : "#—";
  const ago = head ? Math.max(0, Math.round((now - head.seenAtMs) / 1_000)) : 0;
  const label =
    state === "live" ? "New blocks arriving (about every 300 ms)" : state === "stale" ? `No new block for ${ago}s: numbers on screen may be out of date` : "Waiting for the first block";
  return (
    <Tooltip content={label} side="bottom">
      <span data-testid="block-counter" data-state={state}>
        <Chip tone={state === "stale" ? "warn" : state === "live" ? "brand" : "neutral"} dot pulse={state === "live"} className="num">
          {state === "stale" ? `stale ${compact ? "" : block}` : compact ? block.slice(-6) : `block ${block}`}
        </Chip>
      </span>
    </Tooltip>
  );
}
