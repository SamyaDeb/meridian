"use client";
import { useDataSource } from "@/data/context";

export function TopBar() {
  const ds = useDataSource();
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between bg-bg/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 13h5l2-6 3 11 2-7 1.5 2H22" />
        </svg>
        <span className="text-lg font-semibold tracking-tight">Pulse</span>
        {ds.kind === "mock" && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium uppercase text-warn">mock data</span>}
      </div>
      {/* Login (Privy or Mera) lands after the Day-2 decision (BOUNTY_MAP). */}
      <button type="button" disabled className="rounded-full bg-surface-2 px-4 py-1.5 text-sm text-muted">
        Log in
      </button>
    </header>
  );
}
