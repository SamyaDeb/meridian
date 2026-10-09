// The receipts of trades this app placed and its Earn runs, kept per (chain, wallet) so Activity can reopen them after
// the modal closed and after a restart. Non-secret (amounts, prices, order ids, transaction hashes: all public once on
// chain; an Earn run's plain timeline), in the app's SecureStore KV next to the other prefs; the newest LOG_MAX only.
// Format v1 (unchanged): an entry without `kind` is a trade receipt (as N7 wrote them); `kind: "earn"` an Earn run; an
// entry of a kind this build doesn't know, or that doesn't validate, is skipped, never thrown. Unreadable ⇒ empty log.
import { parseBig, stringifyBig } from "@meridian/core/util";
import type { KV } from "../../auth/credentialStore";
import { Store } from "../../live/store";
import type { Receipt } from "../trade/exec/receipt";
import { isEarnEntry, logEntryId, type LogEntry, type LoggedEarn } from "./model";

export const LOG_MAX = 25;
export const activityLogKey = (chainId: number, address: string) => `meridian.activity.${chainId}.${address.toLowerCase()}`;

function validReceipt(r: unknown): r is Receipt {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Partial<Receipt>;
  return typeof x.ok === "boolean" && (x.venue === "perpl" || x.venue === "meridian") && (x.side === "long" || x.side === "short") && typeof x.filledWad === "bigint" && typeof x.stepWad === "bigint";
}

function validEarn(e: Record<string, unknown>): e is LoggedEarn {
  const x = e.earn as Record<string, unknown> | undefined;
  if (typeof x !== "object" || x === null || typeof x.runId !== "string") return false;
  if (x.run === "leftover") return validReceipt(x.receipt);
  if (x.run !== "open" && x.run !== "close") return false;
  const t = x.timeline as Record<string, unknown> | undefined;
  return typeof x.perplWad === "bigint" && typeof x.meridianWad === "bigint" && typeof x.stepWad === "bigint" && (x.lockWad === undefined || typeof x.lockWad === "bigint") && Array.isArray(x.legIds) && x.legIds.every((i) => typeof i === "string") && typeof t === "object" && t !== null && typeof t.headline === "string" && typeof t.body === "string" && Array.isArray(t.steps);
}

function valid(e: unknown): e is LogEntry {
  if (typeof e !== "object" || e === null) return false;
  const x = e as Record<string, unknown>;
  if (typeof x.atMs !== "number" || (x.block !== undefined && typeof x.block !== "bigint")) return false;
  if (x.kind === undefined) return validReceipt(x.receipt); // v1 trade receipt (N7)
  if (x.kind === "earn") return validEarn(x);
  return false; // a kind from a newer build: skipped
}

export function decodeLog(text: string | null | undefined): LogEntry[] {
  if (!text) return [];
  try {
    const o = parseBig(text) as { v?: unknown; e?: unknown };
    if (o.v !== 1 || !Array.isArray(o.e)) return [];
    return o.e.filter(valid).slice(0, LOG_MAX);
  } catch {
    return [];
  }
}

export const encodeLog = (entries: readonly LogEntry[]): string => stringifyBig({ v: 1, e: entries.slice(0, LOG_MAX) });

export class ActivityLog {
  readonly store = new Store<LogEntry[]>([]);
  private loaded: Promise<void> | undefined;

  constructor(
    private readonly kv: KV,
    private readonly key: string,
  ) {}

  load(): Promise<void> {
    this.loaded ??= this.kv.get(this.key).then(
      (t) => this.store.set(decodeLog(t)),
      () => undefined,
    );
    return this.loaded;
  }

  /**
   * Newest first; an entry for the same order / transaction / Earn run replaces the older one (so an Earn run logged
   * again by a resume after a kill is still one row, and its leftover close replaces that order's plain receipt).
   */
  async add(entry: LogEntry): Promise<void> {
    await this.load();
    const id = logEntryId(entry);
    const r = isEarnEntry(entry) ? undefined : entry.receipt;
    const same = (e: LogEntry) => (id !== undefined && logEntryId(e) === id) || (r !== undefined && !isEarnEntry(e) && ((r.orderId !== undefined && e.receipt.orderId === r.orderId && e.receipt.venue === r.venue) || (r.txHash !== undefined && e.receipt.txHash === r.txHash)));
    const next = [entry, ...this.store.get().filter((e) => !same(e))].slice(0, LOG_MAX);
    this.store.set(next);
    try {
      await this.kv.set(this.key, encodeLog(next));
    } catch {
      // still listed this session
    }
  }
}
