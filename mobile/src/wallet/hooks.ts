// Wallet hooks: live balances for the account (ticks with the block source), and a sender bound to the unlocked account.
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useAuthController } from "../auth/AuthProvider";
import type { Live } from "../live/live";
import { useLive } from "../live/LiveProvider";
import { Store, useStore } from "../live/store";
import { balanceTokens, BalanceReader, type BalanceState } from "./balances";
import { walletClientFor } from "./client";
import { sendTx, type TxRequest, type TxResult } from "./sendTx";

const EMPTY = new Store<BalanceState | undefined>(undefined);
const selSelf = <T,>(s: T) => s;

/** One BalanceReader for `address`, re-read on every new head; `onState` sees each state it publishes. */
export function startBalanceReader(live: Live, address: Address, onState?: (s: BalanceState) => void): { reader: BalanceReader; stop(): void } | undefined {
  if (!live.client || !live.blocks) return undefined;
  const r = new BalanceReader({ client: live.client, address, tokens: balanceTokens(live.config) });
  const blocks = live.blocks;
  const tick = () => {
    const b = blocks.store.get().block;
    if (b !== undefined && b !== r.store.get().block) void r.onBlock(b);
  };
  const unsubState = onState ? r.store.subscribe(() => onState(r.store.get())) : () => undefined;
  tick();
  const unsubBlocks = blocks.store.subscribe(tick);
  return {
    reader: r,
    stop: () => {
      unsubBlocks();
      unsubState();
    },
  };
}

export function useBalances(address: Address | undefined): BalanceState | undefined {
  const live = useLive();
  const [reader, setReader] = useState<BalanceReader | undefined>(undefined);
  useEffect(() => {
    const started = address ? startBalanceReader(live, address) : undefined;
    setReader(started?.reader);
    return started?.stop;
  }, [address, live]);
  return useStore((reader?.store as Store<BalanceState | undefined> | undefined) ?? EMPTY, selSelf);
}

/** Send with the unlocked session (fresh: true ⇒ a new passkey prompt and a per-tx session, for value-moving actions). */
export function useSendTx(): (req: TxRequest, o?: { fresh?: boolean }) => Promise<TxResult> {
  const auth = useAuthController();
  const live = useLive();
  return useCallback(
    async (req, o = {}) => {
      if (!live.client) throw new Error("No RPC is configured for this build");
      const pub = live.client;
      const run = (account: Parameters<typeof walletClientFor>[0]) => sendTx(pub, walletClientFor(account, live.config), req);
      return o.fresh ? auth.withFreshSession(run) : run(auth.account());
    },
    [auth, live],
  );
}
