"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ds";
import { matchCommands, type Command } from "@/lib/commands";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { setDraft } from "@/features/trade/draft";
import { resetLayout } from "@/lib/layout";
import { NAV_ITEMS } from "./nav/items";
import { usePerpMarkets } from "@/data/market";

type Cmd = Command & { run: () => void };

/** ⌘K / Ctrl+K palette: pages, ticket shortcuts, deposit / withdraw, privacy and sound. Every entry does a real thing. */
export function CommandPalette() {
  const router = useRouter();
  const { market: pm, markets, setMarket } = usePerpMarkets();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQ("");
        setSel(0);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const toTrade = (patch: Parameters<typeof setDraft>[0], focusSize = false) => () => {
    router.push("/trade");
    setDraft(patch);
    if (focusSize) setTimeout(() => document.getElementById("size-in")?.focus(), 150);
  };
  const toggle = (k: "hidePnl" | "hideLiq" | "hideBalances" | "sound" | "hotkeys", label: string): Cmd => ({
    id: k,
    title: `${getPrefs()[k] ? "Turn off" : "Turn on"}: ${label}`,
    group: "Settings",
    run: () => setPrefs({ [k]: !getPrefs()[k] }),
  });
  const all: Cmd[] = [
    ...markets.filter((x) => x.key !== pm.key).map((x) => ({ id: `market-${x.key}`, title: `Switch market: ${x.symbol}`, group: "Trade", keywords: `market ${x.base.toLowerCase()}`, run: () => setMarket(x.key) })),
    ...NAV_ITEMS.map((n) => ({ id: `go${n.href}`, title: `Go to ${n.label}`, group: "Pages", run: () => router.push(n.href) })),
    { id: "long", title: `Long ${pm.symbol}`, group: "Trade", keywords: "buy b", run: toTrade({ side: "long" }, true) },
    { id: "short", title: `Short ${pm.symbol}`, group: "Trade", keywords: "sell s", run: toTrade({ side: "short" }, true) },
    { id: "limit", title: "Limit order", group: "Trade", run: toTrade({ kind: "limit" }) },
    { id: "deposit", title: "Deposit AUSD", group: "Account", keywords: "fund add collateral", run: toTrade({ funds: "deposit" }) },
    { id: "withdraw", title: "Withdraw AUSD", group: "Account", keywords: "remove collateral", run: toTrade({ funds: "withdraw" }) },
    toggle("hidePnl", "hide PnL"),
    toggle("hideLiq", "hide liquidation price"),
    toggle("hideBalances", "hide balances"),
    toggle("sound", "sound"),
    toggle("hotkeys", "trade hotkeys"),
    { id: "layout", title: "Reset terminal layout", group: "Settings", keywords: "panels resize", run: resetLayout },
    { id: "terms", title: "Terms & risks", group: "Pages", run: () => router.push("/terms") },
  ];
  const list = matchCommands(all, q);
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Commands">
      <input
        data-autofocus
        aria-label="Search commands"
        aria-controls="cmd-list"
        aria-activedescendant={list[sel] ? `cmd-${list[sel]!.id}` : undefined}
        role="combobox"
        aria-expanded
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((i) => Math.min(list.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(list[sel]);
          }
        }}
        placeholder="Type a command…"
        className="h-11 w-full rounded-control bg-card-2 px-3 text-sm"
      />
      <ul id="cmd-list" role="listbox" aria-label="Commands" className="mt-2 max-h-80 overflow-auto">
        {list.length === 0 && <li className="px-3 py-4 text-center text-xs text-muted">No matching command</li>}
        {list.map((c, i) => (
          <li
            key={c.id}
            id={`cmd-${c.id}`}
            role="option"
            aria-selected={i === sel}
            onMouseEnter={() => setSel(i)}
            onClick={() => run(c)}
            className={`flex min-h-10 cursor-pointer items-center justify-between rounded-control px-3 text-sm pointer-coarse:min-h-11 ${i === sel ? "bg-brand-tint text-brand-soft" : ""}`}
          >
            <span>{c.title}</span>
            <span className="text-[10px] text-muted">{c.group}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
