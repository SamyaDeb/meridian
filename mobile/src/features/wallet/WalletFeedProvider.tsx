// Mounts the wallet feed under the auth gate: one BalanceReader for the unlocked address, arrivals → success toast +
// success haptic (DESIGN.md haptics map) wherever the user is. Locked ⇒ no reads, numbers forgotten.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAccountAddress } from "../../auth/AuthProvider";
import { useLive } from "../../live/LiveProvider";
import { Store, useStore } from "../../live/store";
import { haptic, useToast } from "../../ui";
import { WalletFeedStore, type WalletFeed } from "../../wallet/feed";
import { startBalanceReader } from "../../wallet/hooks";

const Ctx = createContext<WalletFeedStore | undefined>(undefined);

/** `feed` / `read={false}` are for tests: push states into the injected store by hand. */
export function WalletFeedProvider({ children, feed: injected, read = true }: { children: ReactNode; feed?: WalletFeedStore; read?: boolean }) {
  const [feed] = useState(() => injected ?? new WalletFeedStore());
  const live = useLive();
  const toast = useToast();
  const { address, locked } = useAccountAddress();
  const addr = locked ? undefined : address;

  useEffect(() => {
    feed.onArrive = (text) => {
      haptic.success();
      toast(text, "success");
    };
    return () => void (feed.onArrive = undefined);
  }, [feed, toast]);

  useEffect(() => {
    if (!read) return;
    feed.reset();
    if (!addr) return;
    return startBalanceReader(live, addr, (s) => feed.push(s))?.stop;
  }, [addr, live, feed, read]);

  return <Ctx.Provider value={feed}>{children}</Ctx.Provider>;
}

const EMPTY = new Store<WalletFeed>({ balances: undefined, last: undefined });

export function useWalletFeed<S>(select: (f: WalletFeed) => S): S {
  return useStore(useContext(Ctx) ?? EMPTY, select);
}
