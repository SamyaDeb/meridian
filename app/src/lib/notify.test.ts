import { beforeEach, describe, expect, it } from "vitest";
import { clearNotifications, getSnapshot, markAllRead, pushNotification, subscribe } from "./notify";

describe("notifications store", () => {
  beforeEach(() => clearNotifications());
  it("newest first, capped at 20, unread counted", () => {
    for (let i = 0; i < 25; i++) pushNotification("ok", `n${i}`, i);
    const s = getSnapshot();
    expect(s.items).toHaveLength(20);
    expect(s.items[0]?.text).toBe("n24");
    expect(s.unread).toBe(20);
  });
  it("snapshot is stable until something changes (useSyncExternalStore contract)", () => {
    pushNotification("info", "a");
    const a = getSnapshot();
    expect(getSnapshot()).toBe(a);
    markAllRead();
    expect(getSnapshot()).not.toBe(a);
    expect(getSnapshot().unread).toBe(0);
  });
  it("notifies subscribers and unsubscribes", () => {
    let n = 0;
    const off = subscribe(() => n++);
    pushNotification("error", "x");
    off();
    pushNotification("error", "y");
    expect(n).toBe(1);
  });
});
