// Report encoding for MeridianKeeperReceiver (IMeridianKeeperReceiver, interfaces-v1.8): report = abi.encode(uint8 action,
// bytes payload). Pure; unit-tested in test/report.test.ts against the Solidity layout.
import { encodeAbiParameters, type Address, type Hex } from "viem";

export const Action = {
  VAULT_REBALANCE: 1,
  LIQUIDATE: 2,
  FUNDING_POKE: 3,
  ORACLE_UPDATE: 4,
  UNWIND: 5,
  MFI_PUBLISH: 6,
} as const;
export type ActionId = (typeof Action)[keyof typeof Action];

/** MeridianConstants.MAX_BATCH: the receiver reverts BatchTooLarge above it. */
export const MAX_BATCH = 32;

export function encodeReport(action: ActionId, payload: Hex): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [action, payload]);
}

export function liquidateReport(clearingHouse: Address, accounts: readonly Address[]): Hex {
  if (accounts.length === 0 || accounts.length > MAX_BATCH) throw new RangeError(`accounts: 1..${MAX_BATCH}`);
  return encodeReport(Action.LIQUIDATE, encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [clearingHouse, accounts]));
}

export function fundingPokeReport(clearingHouses: readonly Address[]): Hex {
  if (clearingHouses.length === 0 || clearingHouses.length > MAX_BATCH) throw new RangeError(`clearingHouses: 1..${MAX_BATCH}`);
  return encodeReport(Action.FUNDING_POKE, encodeAbiParameters([{ type: "address[]" }], [clearingHouses]));
}

export function vaultRebalanceReport(vault: Address): Hex {
  return encodeReport(Action.VAULT_REBALANCE, encodeAbiParameters([{ type: "address" }], [vault]));
}

export function unwindReport(clearingHouse: Address, maxSizeWad: bigint): Hex {
  return encodeReport(Action.UNWIND, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [clearingHouse, maxSizeWad]));
}

export type MfiObservation = {
  mfiAprWad: bigint;
  meridianAprWad: bigint;
  perplAprWad: bigint;
  blockNumber: bigint;
  perplFundingBlock: bigint;
};

export function mfiPublishReport(feed: Address, o: MfiObservation): Hex {
  return encodeReport(
    Action.MFI_PUBLISH,
    encodeAbiParameters(
      [{ type: "address" }, { type: "int256" }, { type: "int256" }, { type: "int256" }, { type: "uint64" }, { type: "uint64" }],
      [feed, o.mfiAprWad, o.meridianAprWad, o.perplAprWad, o.blockNumber, o.perplFundingBlock],
    ),
  );
}

/** Monad bills the gas LIMIT (CONTRIBUTING §7): limit = ceil(estimate × 1.2). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
}
