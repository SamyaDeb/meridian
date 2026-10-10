// Onboarding screen state, DETECTED on every launch / unlock / foreground (never trusted from a local flag): core's
// detector (NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY) over the signed wallet read, plus the
// chain's view of the exchange account (getAccountByAddr, no key needed).
//
// Order adapts to one fact measured on 9 Oct 2026: POST /v1/api-key/enroll answers 404 "target profile not found" for a
// wallet Perpl has never seen (fresh throwaway address on testnet). When enrolment says 404 and the chain shows no
// exchange account, the screen offers the deposit (createAccount) first and retries the key after it.
import { detectOnboarding, type Account, type OnboardingObservation, type OnboardingStatus } from "@meridian/core/perpl";

export type ChainAccount = { id: bigint; balanceCns: bigint; lockedCns: bigint };

export type PerplObservation = {
  /** a stored X-API-Key token for this wallet + chain */
  hasToken: boolean;
  /** signed GET /v1/trading/wallet (core observeWallet); undefined = not read (no token, or not yet) */
  wallet: OnboardingObservation["wallet"];
  /** getAccountByAddr: null = no account (the view reverts / id 0), undefined = not read */
  chainAccount: ChainAccount | null | undefined;
  /** the last enrolment attempt answered 404 (profile not found) */
  enrollNeedsAccount: boolean;
};

export type CheckState = "done" | "next" | "waiting" | "unknown";
export type NextStep = "enroll" | "deposit" | "forwarding" | "top-up" | "retry" | "none";

export type OnboardingView = {
  core: OnboardingStatus;
  key: CheckState;
  account: CheckState;
  forwarding: CheckState;
  next: NextStep;
  ready: boolean;
  /** the exchange account from the API when known */
  apiAccount: Account | undefined;
  /** plain words for the status line */
  reason: string;
};

export function onboardingView(o: PerplObservation): OnboardingView {
  const onChain = o.chainAccount ? o.chainAccount.id > 0n : o.chainAccount === null ? false : undefined;
  const core = detectOnboarding({ apiKey: o.hasToken ? "stored" : undefined, wallet: o.wallet, ...(o.chainAccount ? { chainAccountId: o.chainAccount.id } : {}) });
  const base = { core, apiAccount: core.account, reason: core.reason };

  if (core.step === "NO_KEY") {
    const accountFirst = o.enrollNeedsAccount && onChain === false;
    return {
      ...base,
      key: accountFirst ? "waiting" : "next",
      account: onChain ? "done" : accountFirst ? "next" : onChain === undefined ? "unknown" : "waiting",
      forwarding: "unknown",
      next: accountFirst ? "deposit" : "enroll",
      ready: false,
      reason: accountFirst ? "Perpl needs your exchange account before it registers a trading key" : core.reason,
    };
  }

  const k = "done" as const;
  switch (core.step) {
    case "KEY_ENROLLED":
      if (core.next.type === "create-account") return { ...base, key: k, account: "next", forwarding: "waiting", next: "deposit", ready: false };
      return { ...base, key: k, account: onChain ? "done" : "unknown", forwarding: "unknown", next: "retry", ready: false };
    case "ACCOUNT_CREATED":
      return { ...base, key: k, account: "done", forwarding: core.next.type === "allow-forwarding" ? "next" : "unknown", next: core.next.type === "allow-forwarding" ? "forwarding" : "retry", ready: false };
    case "FORWARDING_ON":
      return { ...base, key: k, account: "done", forwarding: "done", next: "top-up", ready: false };
    case "READY":
      return { ...base, key: k, account: "done", forwarding: "done", next: "none", ready: true };
  }
}

/** The order of the three checks as shown: the account moves first when Perpl needs it before the key. */
export function checkOrder(v: OnboardingView): ("key" | "account" | "forwarding")[] {
  return v.next === "deposit" && v.key === "waiting" ? ["account", "key", "forwarding"] : ["key", "account", "forwarding"];
}

/** The status line in plain words (MOBILE_UX_RESEARCH principle 4): no HTTP codes, "API", "forwarding" or ids. `reason`
 *  keeps the technical detail for logs and dev screens. */
export function plainStatus(v: OnboardingView): string {
  if (v.ready) return "Perpl is ready to trade.";
  switch (v.next) {
    case "enroll":
      return /401/.test(v.core.reason) ? "Your Perpl trading key stopped working. Enable trading again." : "Enable Perpl trading to start.";
    case "deposit":
      return v.key === "waiting" ? "Perpl needs a first deposit before it can enable trading." : "Make a first deposit to open your Perpl account.";
    case "forwarding":
      return "One last step: allow fast orders.";
    case "top-up":
      return "Your Perpl account has no free AUSD yet. Add some to trade.";
    case "retry":
    case "none":
      return "Couldn't check Perpl just now. Check again in a moment.";
  }
}

/** Plain names for the onboarding transactions (Details list). */
export const STEP_LABEL = { enroll: "Enable trading", approve: "Allow AUSD", createAccount: "Open account", deposit: "Deposit", forwarding: "Fast orders" } as const;
