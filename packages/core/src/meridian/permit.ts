// EIP-2612 permit: pure builders + validation (one-signature AUSD deposit). Ported from app/src/lib/permit.ts (main @ 0ba1664).
// Domain "Agora Dollar" v"1" (MOBILE_PLAN §0.5, ARCHITECTURE R9).
import type { Address, Hex } from "viem";

/** AUSD's permit domain (verified onchain, see docs/ARCHITECTURE.md §Research). */
export const PERMIT_DOMAIN_NAME = "Agora Dollar";
export const PERMIT_DOMAIN_VERSION = "1";
/** Permit validity window; short on purpose (a leaked signature is worth little). */
export const PERMIT_TTL_SECONDS = 1800n;

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export class PermitError extends Error {
  constructor(
    readonly code: "wrong-chain" | "deadline-expired" | "bad-signature",
    message: string,
  ) {
    super(message);
    this.name = "PermitError";
  }
}

export const permitDeadline = (nowMs: number): bigint => BigInt(Math.floor(nowMs / 1000)) + PERMIT_TTL_SECONDS;

export type PermitParams = { token: Address; owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint; chainId: number };

export function buildPermitTypedData(p: PermitParams) {
  return {
    domain: { name: PERMIT_DOMAIN_NAME, version: PERMIT_DOMAIN_VERSION, chainId: p.chainId, verifyingContract: p.token },
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/** Refuse to ask for a signature that cannot be used: wallet on another chain than the node we read nonces from, or a deadline already past. */
export function assertPermitUsable(o: { walletChainId: number | undefined; nodeChainId: number; deadline: bigint; nowMs: number }): void {
  if (o.walletChainId !== undefined && o.walletChainId !== o.nodeChainId)
    throw new PermitError("wrong-chain", `wallet is on chain ${o.walletChainId}, expected ${o.nodeChainId}`);
  if (o.deadline <= BigInt(Math.floor(o.nowMs / 1000))) throw new PermitError("deadline-expired", "permit deadline already passed");
}

/** 65-byte r‖s‖v signature → (v, r, s) for `permit()`. */
export function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new PermitError("bad-signature", "signature must be 65 bytes");
  let v = Number.parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27; // some embedded signers return 0/1 recovery ids; permit() expects 27/28
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v };
}
