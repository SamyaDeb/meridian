// The receipts of trades this app placed, kept per (chain, wallet) so Activity can reopen them after the modal closed
// and after a restart. Non-secret (amounts, prices, order ids, transaction hashes: all public once on chain), in the
// app's SecureStore KV next to the other prefs; the newest LOG_MAX only. Anything unreadable ⇒ an empty log.
import { parseBig, stringifyBig } from "@meridian/core/util";
import type { KV } from "../../auth/credentialStore";
import { Store } from "../../live/store";
import type { Receipt } from "../trade/exec/receipt";
import type { LoggedReceipt } from "./model";

export const LOG_MAX = 25;
export const activityLogKey = (chainId: number, address: string) => `meridian.activity.${chainId}.${address.toLowerCase()}`;

function valid(e: unknown): e is LoggedReceipt {
  if (typeof e !== "object" || e === null) return false;
  const x = e as { atMs?: unknown; block?: unknown; receipt?: Partial<Receipt> };
  const r = x.receipt;
  return (
    typeof x.atMs === "number" &&
    (x.block === undefined || typeof x.block === "bigint") &&
    typeof r === "object" &&
    r !== null &&
    typeof r.ok === "boolean" &&
    (r.venue === "perpl" || r.venue === "meridian") &&
    (r.side === "long" || r.side === "short") &&
    typeof r.filledWad === "bigint" &&
    typeof r.stepWad === "bigint"
  );
}

export function decodeLog(text: string | null | undefined): LoggedReceipt[] {
  if (!text) return [];
  try {
    const o = parseBig(text) as { v?: unknown; e?: unknown };
    if (o.v !== 1 || !Array.isArray(o.e)) return [];
    return o.e.filter(valid).slice(0, LOG_MAX);
  } catch {
    return [];
  }
}

export const encodeLog = (entries: readonly LoggedReceipt[]): string => stringifyBig({ v: 1, e: entries.slice(0, LOG_MAX) });

export class ActivityLog {
  readonly store = new Store<LoggedReceipt[]>([]);
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

  /** newest first; a receipt for the same order / transaction replaces the older one */
  async add(entry: LoggedReceipt): Promise<void> {
    await this.load();
    const r = entry.receipt;
    const same = (e: LoggedReceipt) => (r.orderId !== undefined && e.receipt.orderId === r.orderId && e.receipt.venue === r.venue) || (r.txHash !== undefined && e.receipt.txHash === r.txHash);
    const next = [entry, ...this.store.get().filter((e) => !same(e))].slice(0, LOG_MAX);
    this.store.set(next);
    try {
      await this.kv.set(this.key, encodeLog(next));
    } catch {
      // still listed this session
    }
  }
}
