// Meridian ClearingHouse views the MFI reads (IClearingHouse / IFundingRateOracle, interfaces-v1.5).
// test/meridian.test.ts checks every entry against the committed abis/IClearingHouse.json, so drift fails CI.
import { parseAbi } from "viem";

export const clearingHouseMfiAbi = parseAbi([
  "function averageFundingApr(uint64 blocksAgo) view returns (int256 aprWad)",
  "function latestObservation() view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber)",
  "function markPrice() view returns (uint256 priceWad)",
  "function openInterest() view returns (uint256 longOI, uint256 shortOI)",
  "struct RiskParams { uint256 imr; uint256 mmr; uint256 takerFee; int256 makerFee; uint256 liqPenalty; uint256 keeperShare; uint256 maxOpenInterest; uint256 maxPositionSize; }",
  "function riskParams() view returns (RiskParams)",
  "error OracleStale()",
  "error ObservationTooOld()",
]);
