// One order at a time across the app's three executors (MOBILE_PLAN N6 + N7): the Trade executor (ticket, single close,
// Earn's one-tap leftover close), Close all's two-leg executor and Earn's two-leg executor. TradeProvider owns one lock;
// each executor registers how to tell it's running and how to resume, and asks the lock before it starts. Earn sits
// below TradeProvider, so it registers through the kit (no new context, no import from trade into earn's provider).
// Resume after an unlock or relaunch runs in a fixed order, one at a time, awaited: single trade, Close all, Earn.
// N8: the remote kill switch sits next to `blocked()`: `opensBlocked(kind)` is the one question every OPEN asks (Trade
// ticket non-reduce-only, Earn open, Lock-on, Perpl setup). Closes, Close all, the leftover close and resume never ask it.
import type { OpenKind } from "../../flags/model";

export type OrderKind = "single" | "closeAll" | "earn";
export const ORDER_KINDS: readonly OrderKind[] = ["single", "closeAll", "earn"];

/** Why a new order can't start while `kind` runs, in plain words. */
export const BUSY_TEXT: Record<OrderKind, string> = {
  single: "A trade is still going through. Try again when it's done.",
  closeAll: "Close all is still going through. Try again when it's done.",
  earn: "An Earn trade is still going through. Try again when it's done.",
};

export type OrderParty = { busy: () => boolean; resume?: () => Promise<unknown> };

export class OrderLock {
  private parties: Partial<Record<OrderKind, OrderParty>> = {};
  private queue: Promise<void> = Promise.resolve();
  private opensGate: ((kind: OpenKind) => string | undefined) | undefined;

  /** The flags policy (features/flags): set by TradeProvider from FlagsProvider. Unset ⇒ opens allowed. */
  setOpensGate(gate: ((kind: OpenKind) => string | undefined) | undefined): void {
    this.opensGate = gate;
  }

  /** Why an open of `kind` is refused right now (kill switch / forced update), or undefined. Never asked by a close. */
  opensBlocked(kind: OpenKind): string | undefined {
    return this.opensGate?.(kind);
  }

  /** Register (or replace) an executor; the returned function unregisters it if it's still the one registered. */
  register(kind: OrderKind, party: OrderParty): () => void {
    this.parties[kind] = party;
    return () => {
      if (this.parties[kind] === party) delete this.parties[kind];
    };
  }

  /** Why `kind` can't start now (another executor is running), or undefined. */
  blocked(kind: OrderKind): string | undefined {
    for (const k of ORDER_KINDS) if (k !== kind && this.parties[k]?.busy()) return BUSY_TEXT[k];
    return undefined;
  }

  /** Resume the given executors (all by default) in the fixed order, one at a time, after any resume already queued. */
  resume(kinds: readonly OrderKind[] = ORDER_KINDS): Promise<void> {
    const run = async () => {
      for (const k of ORDER_KINDS) {
        if (!kinds.includes(k)) continue;
        try {
          await this.parties[k]?.resume?.();
        } catch {
          // a resume that can't finish keeps its record; the next unlock / focus picks it up
        }
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
