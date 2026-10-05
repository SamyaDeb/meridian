// Trigger-order client: the real manager (CR-012 ABI, once deployed) or an in-memory mock for building the UI.
// Feature flag: "live" only when deployments/<chain>.json has TriggerOrderManager; "mock" only with
// NEXT_PUBLIC_TRIGGERS_MOCK=1 (dev / review builds; every mock tx says "nothing sent"); otherwise "off" (hidden).
import type { Address, PublicClient, WalletClient } from "viem";
import { contractAddress } from "@/config/deployments";
import { approveOrPermit, sendTx } from "@/lib/tx";
import { TRIGGER_KIND, triggerManagerAbi, type TriggerKind, type TriggerView } from "./abi";

export type TriggerMode = "live" | "mock" | "off";
const MAINNET_CHAIN_ID = 143;
export function triggerMode(chainId: number, mockFlag = process.env.NEXT_PUBLIC_TRIGGERS_MOCK): TriggerMode {
  if (contractAddress(chainId, "TriggerOrderManager")) return "live";
  // decision D9: mainnet ships without a TriggerOrderManager and never with the mock, whatever the build flags say
  if (chainId === MAINNET_CHAIN_ID) return "off";
  return mockFlag === "1" ? "mock" : "off";
}

export type CreateParams = { kind: TriggerKind; isBid: boolean; lots: bigint; triggerPriceWad: bigint; limitTick: number; expiryBlock: bigint };
type TxResult = { block: bigint; gasUsed: bigint; gasLimit: bigint };

export interface TriggerClient {
  readonly mode: "live" | "mock";
  list(account: Address): Promise<TriggerView[]>;
  tip(): Promise<bigint>;
  create(pub: PublicClient, wallet: WalletClient, p: CreateParams): Promise<TxResult>;
  cancel(pub: PublicClient, wallet: WalletClient, id: bigint): Promise<TxResult>;
}

const KIND_OF = (k: number): TriggerKind => (k === TRIGGER_KIND.TakeProfitMarket ? "TakeProfitMarket" : "StopMarket");

export function chainTriggerClient(pub: PublicClient, manager: Address, ausd: Address): TriggerClient {
  const c = { address: manager, abi: triggerManagerAbi } as const;
  return {
    mode: "live",
    async list(account) {
      const ids = await pub.readContract({ ...c, functionName: "triggersOf", args: [account] });
      const rows = await Promise.all(ids.map((id) => pub.readContract({ ...c, functionName: "getTrigger", args: [id] })));
      return rows.map((t, i) => ({ id: ids[i]!, kind: KIND_OF(t.kind), isBid: t.isBid, lots: t.lots, triggerPriceWad: t.triggerPriceWad, limitTick: t.limitTick, expiryBlock: t.expiryBlock, tipToken: t.tipToken }));
    },
    tip: () => pub.readContract({ ...c, functionName: "executionTip" }),
    async create(p, w, x) {
      // the creator pre-pays the execution tip (CR-012 (4)): allowance first (permit where AUSD supports it)
      const tip = await pub.readContract({ ...c, functionName: "executionTip" });
      if (tip > 0n) await approveOrPermit(p, w, ausd, manager, tip);
      return sendTx(p, w, { ...c, functionName: "createTrigger", args: [TRIGGER_KIND[x.kind], x.isBid, x.lots, x.triggerPriceWad, x.limitTick, x.expiryBlock] });
    },
    cancel: (p, w, id) => sendTx(p, w, { ...c, functionName: "cancelTrigger", args: [id] }),
  };
}

/** In-memory stand-in with the same shape. Nothing leaves the browser; results carry block 0. */
export function mockTriggerClient(): TriggerClient {
  let seq = 0n;
  const store = new Map<string, TriggerView[]>();
  const MOCK_TIP = 50_000n; // 0.05 AUSD, mock value only
  const none = async (): Promise<TxResult> => ({ block: 0n, gasUsed: 0n, gasLimit: 0n });
  return {
    mode: "mock",
    list: async (a) => [...(store.get(a.toLowerCase()) ?? [])],
    tip: async () => MOCK_TIP,
    async create(_p, w, x) {
      const a = w.account?.address.toLowerCase();
      if (!a) throw new Error("wallet not connected");
      const list = store.get(a) ?? [];
      if (list.length >= 8) throw new Error("TooManyTriggers (mock: 8 per account)");
      store.set(a, [...list, { id: ++seq, ...x, tipToken: MOCK_TIP }]);
      return none();
    },
    async cancel(_p, w, id) {
      const a = w.account?.address.toLowerCase();
      if (a) store.set(a, (store.get(a) ?? []).filter((t) => t.id !== id));
      return none();
    },
  };
}
