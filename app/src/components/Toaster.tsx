"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe, type Notification } from "@/lib/notify";
import { usePrefs } from "@/lib/prefs";

/** Short tone (WebAudio, no asset): higher for success, lower for errors. Only when the viewer turned sound on. */
function beep(ok: boolean) {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.2);
    o.onended = () => void ctx.close();
  } catch {
    /* audio blocked: toasts still show */
  }
}

/** Toasts for this tab's transaction outcomes (the same events as the navbar bell). Live region, 5 s each. */
export function Toaster() {
  const { items } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const prefs = usePrefs();
  const seen = useRef(items[0]?.id ?? 0);
  const [shown, setShown] = useState<Notification[]>([]);
  useEffect(() => {
    const fresh = items.filter((n) => n.id > seen.current);
    if (!fresh.length) return;
    seen.current = fresh[0]!.id;
    if (prefs.sound) beep(fresh[0]!.tone !== "error");
    queueMicrotask(() => setShown((s) => [...fresh, ...s].slice(0, 3)));
    const ids = fresh.map((f) => f.id);
    const t = setTimeout(() => setShown((s) => s.filter((x) => !ids.includes(x.id))), 5_000);
    return () => clearTimeout(t);
  }, [items, prefs.sound]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-2 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-end gap-2 lg:bottom-4 lg:right-4 lg:left-auto">
      {shown.map((n) => (
        <div key={n.id} role="status" className={`pointer-events-auto max-w-sm rounded-inner border px-3 py-2 text-xs card-elev ${n.tone === "error" ? "border-short/40 bg-card text-short" : "border-border bg-card text-text"}`}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
