import type { MeridianDataSource } from "../source";
import * as fx from "./fixtures";

/** Mock data source: same shapes as the indexer, advancing one "block" every 300 ms. */
export function createMockSource(now: () => number = Date.now): MeridianDataSource {
  const head = () => fx.blockAt(now());
  return {
    kind: "mock",
    market: async () => fx.market(head()),
    fundingTicks: async (limit) => fx.fundingTicks(head(), limit),
    candles1m: async (limit) => fx.candles1m(head(), limit),
    trades: async (limit) => fx.trades(head(), limit),
    depth: async (levels) => fx.depth(head(), levels),
    positions: async (account) => fx.positions(head(), account),
    accountView: async (account) => fx.accountView(head(), account),
    riskParams: async () => fx.riskParams(),
    vault: async () => fx.vault(head()),
    vaultSnapshots: async (limit) => fx.vaultSnapshots(head(), limit),
    vaultUser: async (account) => fx.vaultUser(head(), account),
    swapStats: async () => fx.swapStats(head()),
    swapInfo: async () => fx.swapInfo(),
    swapPositions: async (account) => fx.swapPositions(head(), account),
    protocolStats: async () => fx.protocolStats(head()),
  };
}
