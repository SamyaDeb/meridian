// Full generated ABIs (abis/*.json, tools/export_abis.sh from contracts/out), re-exported from @meridian/abis.
// JSON imports are typed as plain arrays; use the `as const` fragments in ./abi for typed reads and writes.
import type { Abi } from "viem";
import ClearingHouse from "@meridian/abis/ClearingHouse.json";
import FundingSwapMarket from "@meridian/abis/FundingSwapMarket.json";
import MeridianVault from "@meridian/abis/MeridianVault.json";
import OrderBook from "@meridian/abis/OrderBook.json";

export const fullAbis = {
  ClearingHouse: ClearingHouse as Abi,
  OrderBook: OrderBook as Abi,
  FundingSwapMarket: FundingSwapMarket as Abi,
  MeridianVault: MeridianVault as Abi,
} as const;
