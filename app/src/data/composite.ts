// K7: the data source for one selected perp market. Market reads (book, trades, funding, positions, account, risk and
// the chain source's openOrders / fundingSettlements) come from that market's source; the vault, funding swaps and
// protocol stats always come from the primary market's (they are MON-PERP layers). Pure.
import type { MeridianDataSource } from "./source";

export function withPerpMarket<P extends MeridianDataSource>(primary: MeridianDataSource, perp: P, marketKey: string): P {
  return {
    ...perp,
    kind: primary.kind,
    marketKey,
    vault: primary.vault,
    vaultSnapshots: primary.vaultSnapshots,
    vaultUser: primary.vaultUser,
    swapStats: primary.swapStats,
    swapInfo: primary.swapInfo,
    swapPositions: primary.swapPositions,
    protocolStats: primary.protocolStats,
  };
}
