import { describe, expect, it } from "vitest";
import { toFunctionSelector, toEventSelector, type Abi, type AbiEvent, type AbiFunction } from "viem";
import { clearingHouseAbi, mfiFeedAbi, oracleAbi, receiverAbi, vaultAbi } from "../shared/abi";
import ClearingHouse from "@meridian/abis/IClearingHouse.json" with { type: "json" };
import Vault from "@meridian/abis/IMeridianVault.json" with { type: "json" };
import Oracle from "@meridian/abis/IOracleAdapter.json" with { type: "json" };
import Feed from "@meridian/abis/IMeridianMfiFeed.json" with { type: "json" };
import Receiver from "@meridian/abis/IMeridianKeeperReceiver.json" with { type: "json" };
import MeridianVault from "@meridian/abis/MeridianVault.json" with { type: "json" };

function sigs(abi: Abi): Set<string> {
  const s = new Set<string>();
  for (const x of abi) {
    if (x.type === "function") s.add(toFunctionSelector(x as AbiFunction));
    if (x.type === "event") s.add(toEventSelector(x as AbiEvent));
  }
  return s;
}

describe("hand-written fragments match the generated abis/ (selectors and topics)", () => {
  for (const [name, mine, theirs] of [
    ["ClearingHouse", clearingHouseAbi, ClearingHouse],
    ["Vault", vaultAbi, [...Vault, ...MeridianVault]],
    ["Oracle", oracleAbi, Oracle],
    ["MfiFeed", mfiFeedAbi, Feed],
    ["Receiver", receiverAbi, Receiver],
  ] as const) {
    it(name, () => {
      const want = sigs(theirs as Abi);
      for (const s of sigs(mine as Abi)) expect(want.has(s), `${name}: ${s}`).toBe(true);
    });
  }
});
