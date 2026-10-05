"use client";
import { useSyncExternalStore } from "react";
import { EmptyState, Popover } from "@/components/ds";
import { getServerSnapshot, getSnapshot, markAllRead, subscribe } from "@/lib/notify";

/** This tab's transaction outcomes (from useTx). Opening the panel marks them read. */
export function Bell() {
  const { items, unread } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <Popover
      label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      triggerClassName="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-card-2 hover:text-text pointer-coarse:h-11 pointer-coarse:w-11"
      trigger={
        <>
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 003.4 0" />
          </svg>
          {unread > 0 && <span className="num absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-[10px] leading-4 text-on-brand">{unread}</span>}
        </>
      }
    >
      {() => {
        if (unread) queueMicrotask(markAllRead);
        return items.length === 0 ? (
          <EmptyState title="No notifications yet" body="Your transactions in this tab (orders, deposits, closes) show up here." />
        ) : (
          <ul className="max-h-80 space-y-1 overflow-auto">
            {items.map((n) => (
              <li key={n.id} className="rounded-control px-3 py-2 text-xs hover:bg-card-2">
                <span className={n.tone === "error" ? "text-short" : n.tone === "ok" ? "text-text" : "text-muted"}>{n.text}</span>
                <span className="num block text-[10px] text-muted">{new Date(n.atMs).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        );
      }}
    </Popover>
  );
}
