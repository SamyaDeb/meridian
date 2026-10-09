// The unlocked wallet's balances for the whole app (one reader) + the deposit-arrival moment (MOBILE_UX_RESEARCH M4,
// §5.1): each new BalanceReader state is diffed against the previous one (detectArrival, pure); a rise calls
// `onArrive` with "+12.50 AUSD arrived" and is kept as `last` (the Add funds screen shows it in place of "Waiting…").
import { Store } from "../live/store";
import { arrivalText, detectArrival } from "./arrival";
import type { BalanceState } from "./balances";

export type LastArrival = { text: string; block: bigint | undefined; seq: number };
export type WalletFeed = { balances: BalanceState | undefined; last: LastArrival | undefined };

export class WalletFeedStore extends Store<WalletFeed> {
  private prev: BalanceState | undefined;
  private seq = 0;
  onArrive: ((text: string) => void) | undefined;

  constructor() {
    super({ balances: undefined, last: undefined });
  }

  push(next: BalanceState): void {
    const a = detectArrival(this.prev, next);
    this.prev = next;
    if (!a.length) return this.update({ balances: next });
    const text = a.map(arrivalText).join(" · ");
    this.set({ balances: next, last: { text, block: next.block, seq: ++this.seq } });
    this.onArrive?.(text);
  }

  /** a new address (or lock): forget the previous wallet's numbers so nothing is compared across wallets */
  reset(): void {
    this.prev = undefined;
    this.set({ balances: undefined, last: undefined });
  }
}
