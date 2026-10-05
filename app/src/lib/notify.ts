// Session notifications (navbar bell; toasts in F4). In-memory only: they describe this tab's own transactions,
// never protocol data, and vanish on reload.
export type Notification = { id: number; atMs: number; tone: "ok" | "error" | "info"; text: string };

const MAX = 20;
let items: readonly Notification[] = [];
let unread = 0;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushNotification(tone: Notification["tone"], text: string, nowMs = Date.now()): void {
  items = [{ id: ++seq, atMs: nowMs, tone, text }, ...items].slice(0, MAX);
  unread = Math.min(MAX, unread + 1);
  emit();
}
export function markAllRead(): void {
  if (unread === 0) return;
  unread = 0;
  emit();
}
export function clearNotifications(): void {
  items = [];
  unread = 0;
  emit();
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
// stable snapshot objects for useSyncExternalStore
let snap = { items, unread };
export function getSnapshot(): { items: readonly Notification[]; unread: number } {
  if (snap.items !== items || snap.unread !== unread) snap = { items, unread };
  return snap;
}
const EMPTY = { items: [] as readonly Notification[], unread: 0 };
export const getServerSnapshot = () => EMPTY;
