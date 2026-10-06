// ITriggerOrderManager as PROPOSED in CR-012 (docs/CHANGE_REQUESTS.md, status Proposed 5 Oct). NOT an applied interface.
// > VERIFY every name, argument order, the Kind enum values and the tip getter against contracts/src/interfaces/
// ITriggerOrderManager.sol (interfaces-v1.6) once a WS-00 session applies CR-012. This is the ONE file to swap:
// everything else imports the types below.
import { parseAbi } from "viem";

export const TRIGGER_KIND = { StopMarket: 0, TakeProfitMarket: 1 } as const; // > VERIFY enum order
export type TriggerKind = keyof typeof TRIGGER_KIND;

export const triggerManagerAbi = parseAbi([
  "struct Trigger { address owner; uint8 kind; bool isBid; uint64 lots; uint256 triggerPriceWad; uint32 limitTick; uint64 expiryBlock; uint256 tipToken; }",
  "function createTrigger(uint8 kind, bool isBid, uint64 lots, uint256 triggerPriceWad, uint32 limitTick, uint64 expiryBlock) returns (uint64 id)",
  "function cancelTrigger(uint64 id)",
  "function getTrigger(uint64 id) view returns (Trigger)",
  "function triggersOf(address account) view returns (uint64[] ids)",
  "function executionTip() view returns (uint256 amountToken)", // > VERIFY getter name (CR-012 says a bounded AUSD param)
  "event TriggerCreated(uint64 indexed id, address indexed owner)",
  "event TriggerExecuted(uint64 indexed id, address indexed executor)",
  "event TriggerCancelled(uint64 indexed id)",
  "event TriggerExpired(uint64 indexed id)",
]);

/** A trigger as the UI uses it (decoded from getTrigger). */
export type TriggerView = {
  id: bigint;
  kind: TriggerKind;
  /** order side when it fires: a long's stop sells (isBid false) */
  isBid: boolean;
  lots: bigint;
  triggerPriceWad: bigint;
  limitTick: number;
  expiryBlock: bigint;
  tipToken: bigint;
};

/** Max open triggers per account (CR-012: MAX_TRIGGERS_PER_ACCOUNT = 8, proposed). > VERIFY in MeridianConstants. */
export const MAX_TRIGGERS_PER_ACCOUNT = 8;
