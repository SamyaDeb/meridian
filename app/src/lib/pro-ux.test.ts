import { describe, expect, it } from "vitest";
import { matchCommands } from "./commands";
import { hotkeyAction } from "./hotkeys";
import { DEFAULT_PREFS, parsePrefs, setPrefs } from "./prefs";

describe("prefs", () => {
  it("parses booleans, ignores junk", () => {
    expect(parsePrefs(JSON.stringify({ hidePnl: true, sound: "yes", extra: 1 }))).toEqual({ ...DEFAULT_PREFS, hidePnl: true });
    expect(parsePrefs("{oops")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  });
  it("setPrefs survives a throwing localStorage", () => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(() => setPrefs({ hideBalances: true })).not.toThrow();
    g.localStorage = prev;
  });
});

describe("hotkeys", () => {
  it("letters map to ticket actions", () => {
    expect(hotkeyAction({ key: "b" })).toEqual({ type: "side", side: "long" });
    expect(hotkeyAction({ key: "S" })).toEqual({ type: "side", side: "short" });
    expect(hotkeyAction({ key: "m" })).toEqual({ type: "kind", kind: "market" });
    expect(hotkeyAction({ key: "l" })).toEqual({ type: "kind", kind: "limit" });
    expect(hotkeyAction({ key: "/" })).toEqual({ type: "focusSize" });
    expect(hotkeyAction({ key: "Escape" })).toEqual({ type: "clear" });
  });
  it("never fire while typing; palette always opens; other modifiers pass through", () => {
    expect(hotkeyAction({ key: "b", targetTag: "input" })).toBeUndefined();
    expect(hotkeyAction({ key: "l", editable: true })).toBeUndefined();
    expect(hotkeyAction({ key: "Escape", targetTag: "INPUT" })).toBeUndefined();
    expect(hotkeyAction({ key: "k", metaKey: true, targetTag: "INPUT" })).toEqual({ type: "palette" });
    expect(hotkeyAction({ key: "k", ctrlKey: true })).toEqual({ type: "palette" });
    expect(hotkeyAction({ key: "b", ctrlKey: true })).toBeUndefined();
    expect(hotkeyAction({ key: "x" })).toBeUndefined();
  });
});

describe("command matching", () => {
  const all = [
    { id: "go-trade", title: "Go to Trade", group: "Pages" },
    { id: "go-earn", title: "Go to Earn", group: "Pages", keywords: "vault yield" },
    { id: "hide-pnl", title: "Hide PnL", group: "Privacy" },
    { id: "deposit", title: "Deposit AUSD", group: "Account" },
  ];
  it("every word must match; keywords count", () => {
    expect(matchCommands(all, "go earn").map((c) => c.id)).toEqual(["go-earn"]);
    expect(matchCommands(all, "vault").map((c) => c.id)).toEqual(["go-earn"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
  });
  it("title-prefix matches rank first; empty query lists all", () => {
    expect(matchCommands(all, "d").map((c) => c.id)[0]).toBe("deposit");
    expect(matchCommands(all, "")).toHaveLength(4);
  });
});
