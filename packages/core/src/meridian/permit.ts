// EIP-2612 permit: pure builders + validation (one-signature collateral deposit). Ported from app/src/lib/permit.ts (main @ 0ba1664).
// Domain read from the token (EIP-5267 eip712Domain); the collateral is USDC since 4 Nov 2026.
import type { Address, Hex } from "viem";

/** EIP-712 domain of the collateral token (name + version), read from the token itself: never hard-coded (4 Nov 2026). */
export type PermitDomain = { name: string; version: string };

/**
 * Pure: an EIP-5267 `eip712Domain()` result → the permit domain, or undefined when it can't be trusted for a permit:
 * name or version not declared in `fields` (bits 0x01, 0x02), a chain id other than the node's, or a verifying
 * contract other than the token. Undefined ⇒ the caller uses approve (one more tx, never a wrong signature).
 */
export function permitDomainFrom(raw: readonly [fields: Hex, name: string, version: string, chainId: bigint, verifyingContract: Address, ...rest: unknown[]], token: Address, chainId: number): PermitDomain | undefined {
  const [fields, name, version, cid, vc] = raw;
  const f = Number.parseInt(fields.slice(2) || "0", 16);
  if ((f & 0x03) !== 0x03 || name === "" || version === "") return undefined;
  if (f & 0x04 && cid !== BigInt(chainId)) return undefined;
  if (f & 0x08 && vc.toLowerCase() !== token.toLowerCase()) return undefined;
  return { name, version };
}
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

export type PermitParams = { token: Address; owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint; chainId: number; domain: PermitDomain };

export function buildPermitTypedData(p: PermitParams) {
  return {
    domain: { name: p.domain.name, version: p.domain.version, chainId: p.chainId, verifyingContract: p.token },
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
