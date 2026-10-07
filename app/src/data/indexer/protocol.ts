// Protocol history from the indexer (K2.4): one row per UTC day (ProtocolDaily) and the insurance-fund waterfall
// (InsuranceFundEvent). Test markets are excluded by the indexer, like ProtocolStats.
import { big, int, optBig, postGql } from "./stats";
import { rows, str, optStr } from "./rows";

export type ProtocolDay = {
  day: number; // unix seconds, 00:00 UTC
  perpVolumeQuoteWad: bigint;
  perpVolumeMmQuoteWad: bigint;
  swapVolumeWad: bigint;
  feesWad: bigint;
  trades: number;
  liquidations: number;
  newExternalUsers: number;
  activeExternalUsers: number;
  tvlTokenClose: bigint;
  vaultNavTokenClose: bigint;
  perpOpenInterestLongWadClose: bigint;
  perpOpenInterestShortWadClose: bigint;
  swapOpenInterestWadClose: bigint;
};

export const PROTOCOL_DAILY_QUERY = `query MeridianProtocolDaily($chainId: Int!, $limit: Int!) {
  ProtocolDaily(where: { chainId: { _eq: $chainId } }, order_by: { day: desc }, limit: $limit) {
    day perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad feesWad trades liquidations newExternalUsers activeExternalUsers
    tvlTokenClose vaultNavTokenClose perpOpenInterestLongWadClose perpOpenInterestShortWadClose swapOpenInterestWadClose
  }
}`;

/** Pure: oldest first. */
export function parseProtocolDaily(data: unknown): ProtocolDay[] {
  return rows(data, "ProtocolDaily")
    .map((r) => ({
      day: Number(big(r.day, "day")),
      perpVolumeQuoteWad: big(r.perpVolumeQuoteWad, "perpVolumeQuoteWad"),
      perpVolumeMmQuoteWad: big(r.perpVolumeMmQuoteWad, "perpVolumeMmQuoteWad"),
      swapVolumeWad: big(r.swapVolumeWad, "swapVolumeWad"),
      feesWad: big(r.feesWad, "feesWad"),
      trades: int(r.trades, "trades"),
      liquidations: int(r.liquidations, "liquidations"),
      newExternalUsers: int(r.newExternalUsers, "newExternalUsers"),
      activeExternalUsers: int(r.activeExternalUsers, "activeExternalUsers"),
      tvlTokenClose: big(r.tvlTokenClose, "tvlTokenClose"),
      vaultNavTokenClose: big(r.vaultNavTokenClose, "vaultNavTokenClose"),
      perpOpenInterestLongWadClose: big(r.perpOpenInterestLongWadClose, "perpOpenInterestLongWadClose"),
      perpOpenInterestShortWadClose: big(r.perpOpenInterestShortWadClose, "perpOpenInterestShortWadClose"),
      swapOpenInterestWadClose: big(r.swapOpenInterestWadClose, "swapOpenInterestWadClose"),
    }))
    .sort((a, b) => a.day - b.day);
}

export const fetchProtocolDaily = async (url: string, chainId: number, days: number, signal?: AbortSignal) =>
  parseProtocolDaily(await postGql(url, PROTOCOL_DAILY_QUERY, { chainId, limit: days }, signal));

export const INSURANCE_FLOWS = ["Funded", "PenaltyIn", "CoveredByInsurance", "CoveredByFees", "Uncovered"] as const;
export type InsuranceFlow = (typeof INSURANCE_FLOWS)[number];

export type InsuranceStep = {
  id: string;
  flow: InsuranceFlow;
  direction: "In" | "Out" | "None";
  kind?: "Perp" | "Swap";
  market?: string;
  account?: string;
  amountWad: bigint;
  requestedWad?: bigint;
  balanceAfterToken: bigint;
  block: bigint;
  timestamp: bigint;
  txHash: string;
};

export const INSURANCE_QUERY = `query MeridianInsuranceFlows($chainId: Int!, $limit: Int!) {
  InsuranceFundEvent(where: { chainId: { _eq: $chainId } }, order_by: [{ block: desc }, { id: desc }], limit: $limit) {
    id flow direction kind market account amountWad requestedWad balanceAfterToken block timestamp txHash
  }
}`;

/** Pure: in waterfall order (oldest first; inside a tx by step id). Unknown flow / direction strings throw. */
export function parseInsurance(data: unknown): InsuranceStep[] {
  return rows(data, "InsuranceFundEvent")
    .map((r) => {
      const flow = str(r.flow, "flow") as InsuranceFlow;
      if (!INSURANCE_FLOWS.includes(flow)) throw new Error("indexer: bad flow");
      const direction = str(r.direction, "direction");
      if (direction !== "In" && direction !== "Out" && direction !== "None") throw new Error("indexer: bad direction");
      const kind = optStr(r.kind, "kind");
      if (kind !== undefined && kind !== "Perp" && kind !== "Swap") throw new Error("indexer: bad kind");
      const market = optStr(r.market, "market");
      const account = optStr(r.account, "account");
      const requestedWad = optBig(r.requestedWad, "requestedWad");
      return {
        id: str(r.id, "id"),
        flow,
        direction,
        ...(kind ? { kind } : {}),
        ...(market ? { market } : {}),
        ...(account ? { account } : {}),
        amountWad: big(r.amountWad, "amountWad"),
        ...(requestedWad !== undefined ? { requestedWad } : {}),
        balanceAfterToken: big(r.balanceAfterToken, "balanceAfterToken"),
        block: big(r.block, "block"),
        timestamp: big(r.timestamp, "timestamp"),
        txHash: str(r.txHash, "txHash"),
      } satisfies InsuranceStep;
    })
    .sort((a, b) => (a.block === b.block ? stepOrder(a.id) - stepOrder(b.id) : a.block < b.block ? -1 : 1));
}

/** "<block>-<logIndex>-<step>" → sortable within a block (logIndex, then step). */
function stepOrder(id: string): number {
  const [, log = "0", step = "0"] = id.split("-");
  return Number(log) * 10 + Number(step);
}

export const fetchInsurance = async (url: string, chainId: number, limit: number, signal?: AbortSignal) =>
  parseInsurance(await postGql(url, INSURANCE_QUERY, { chainId, limit }, signal));
