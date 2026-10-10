// Perpl onboarding: NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY, DETECTED from API/chain reads on every
// load (resumable: the app never stores the step). Source: api-docs @ 25ab6e2 README "API Auth vs Smart Contract Account"
// (three separate things), "Creating an Exchange Account", "Enabling Order Forwarding" (no onchain getter: read `fw` on
// the wallet snapshot), rest-endpoints.md "Trading State Endpoints" (404 = no exchange account), authentication.md (401 =
// key not accepted). Tx builders return viem call data; the app signs and sends them (gas = estimate × 1.2).
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { perplExchangeAbi } from "./abi";
import { PerplHttpError } from "./errors";
import type { SignedRest } from "./rest";
import type { Account } from "./types";

export type OnboardingStep = "NO_KEY" | "KEY_ENROLLED" | "ACCOUNT_CREATED" | "FORWARDING_ON" | "READY";
export const ONBOARDING_ORDER: readonly OnboardingStep[] = ["NO_KEY", "KEY_ENROLLED", "ACCOUNT_CREATED", "FORWARDING_ON", "READY"];

/** What the detector saw. `wallet` = signed GET /v1/trading/wallet; `chainAccountId` = getAccountByAddr (0n / undefined = none). */
export type OnboardingObservation = {
  /** the stored X-API-Key token for this wallet + chain (non-secret identifier; absent ⇒ never enrolled on this device) */
  apiKey: string | undefined;
  wallet: { ok: true; accounts: Account[] } | { ok: false; status: number } | undefined;
  chainAccountId?: bigint | undefined;
};

export type OnboardingNext =
  | { type: "enroll-key" }
  | { type: "create-account"; minOpenCns: "read getMinAccountOpenCNS()" }
  | { type: "allow-forwarding" }
  | { type: "deposit" }
  | { type: "none" }
  | { type: "retry"; reason: string };

export type OnboardingStatus = { step: OnboardingStep; next: OnboardingNext; account?: Account; reason: string };

/**
 * Pure detector. READY = forwarding on AND free collateral (balance − locked) > 0; FORWARDING_ON = forwarding on but
 * nothing free to trade with (deposit next). An ambiguous read (5xx / 429 / network) never moves the step backwards: it
 * reports the last certain step with next = retry.
 */
export function detectOnboarding(o: OnboardingObservation): OnboardingStatus {
  if (!o.apiKey) return { step: "NO_KEY", next: { type: "enroll-key" }, reason: "no API key stored for this wallet" };
  const w = o.wallet;
  if (w === undefined) return { step: "KEY_ENROLLED", next: { type: "retry", reason: "wallet not read yet" }, reason: "key stored, not checked" };
  if (!w.ok) {
    if (w.status === 401) return { step: "NO_KEY", next: { type: "enroll-key" }, reason: "Perpl rejected the stored key (401: revoked, expired or never enrolled)" };
    if (w.status === 404) {
      if (o.chainAccountId !== undefined && o.chainAccountId > 0n) return { step: "ACCOUNT_CREATED", next: { type: "retry", reason: "account onchain, API not caught up" }, reason: `onchain account ${o.chainAccountId}, API 404` };
      return { step: "KEY_ENROLLED", next: { type: "create-account", minOpenCns: "read getMinAccountOpenCNS()" }, reason: "no exchange account (404)" };
    }
    return { step: "KEY_ENROLLED", next: { type: "retry", reason: `wallet read HTTP ${w.status}` }, reason: "key stored; wallet read failed" };
  }
  const a = w.accounts[0];
  if (!a) return { step: "KEY_ENROLLED", next: { type: "create-account", minOpenCns: "read getMinAccountOpenCNS()" }, reason: "wallet has no accounts" };
  if (!a.fw) return { step: "ACCOUNT_CREATED", next: { type: "allow-forwarding" }, account: a, reason: `account ${a.id}, forwarding off` };
  if (BigInt(a.b) - BigInt(a.lb) <= 0n) return { step: "FORWARDING_ON", next: { type: "deposit" }, account: a, reason: `account ${a.id}, no free collateral` };
  return { step: "READY", next: { type: "none" }, account: a, reason: `account ${a.id} ready` };
}

/** Reads the wallet through the signed REST client and turns HTTP failures into observations (never throws on 401/404). */
export async function observeWallet(rest: SignedRest | undefined): Promise<OnboardingObservation["wallet"]> {
  if (!rest) return undefined;
  try {
    return { ok: true, accounts: (await rest.wallet()).accounts };
  } catch (e) {
    if (e instanceof PerplHttpError) return { ok: false, status: e.status };
    return { ok: false, status: 0 };
  }
}

export type TxRequest = { to: Address; data: Hex; value: bigint };

/** ERC-20 approve(exchange, amount) on the collateral token (README "Creating an Exchange Account": approve first). */
export const approveCollateralTx = (token: Address, exchange: Address, amountCns: bigint): TxRequest => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [exchange, amountCns] }), value: 0n });

/** createAccount(amountCNS): opens the exchange account with an initial deposit ≥ getMinAccountOpenCNS(). */
export function createAccountTx(exchange: Address, amountCns: bigint, minOpenCns: bigint): TxRequest {
  if (amountCns < minOpenCns) throw new RangeError(`initial deposit ${amountCns} below the minimum ${minOpenCns} (CNS)`);
  return { to: exchange, data: encodeFunctionData({ abi: perplExchangeAbi, functionName: "createAccount", args: [amountCns] }), value: 0n };
}

/** allowOrderForwarding(true), from the account's own wallet ("one-click trading"; emits OrderForwardingUpdated). */
export const allowForwardingTx = (exchange: Address, allow = true): TxRequest => ({ to: exchange, data: encodeFunctionData({ abi: perplExchangeAbi, functionName: "allowOrderForwarding", args: [allow] }), value: 0n });

/** depositCollateral(amountCNS) into an existing account (approve first). */
export const depositCollateralTx = (exchange: Address, amountCns: bigint): TxRequest => ({ to: exchange, data: encodeFunctionData({ abi: perplExchangeAbi, functionName: "depositCollateral", args: [amountCns] }), value: 0n });

/** The read the app makes before createAccount: collateral units (CNS); 10 AUSD on 143, 100 on 10143 (README §Open, 9 Oct). */
export const minAccountOpenRead = (exchange: Address) => ({ address: exchange, abi: perplExchangeAbi, functionName: "getMinAccountOpenCNS" }) as const;
/** getAccountByAddr reverts when no account exists (README "Checking Account Status"): treat a revert as "none". */
export const accountByAddrRead = (exchange: Address, wallet: Address) => ({ address: exchange, abi: perplExchangeAbi, functionName: "getAccountByAddr", args: [wallet] }) as const;
