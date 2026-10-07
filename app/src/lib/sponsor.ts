// Privy native gas sponsorship (K1.2). Pure: decides whether a write is sponsored and how a refusal reads.
// Privy docs (7 Oct 2026): "App pays" lists Monad Testnet; embedded wallets only, sent with `sponsor: true`.

/** Monad Testnet. Mainnet (143) is never sponsored. */
export const SPONSORED_CHAIN_ID = 10143;

export type WalletKind = "embedded" | "external";

export type SponsorInput = {
  privyEnabled: boolean;
  walletKind: WalletKind | undefined;
  chainId: number | undefined;
  /** NEXT_PUBLIC_SPONSOR_GAS: "0" turns sponsorship off (kill switch); unset or anything else leaves it on */
  killSwitch: string | undefined;
};

export function isSponsored(i: SponsorInput): boolean {
  return i.privyEnabled && i.walletKind === "embedded" && i.chainId === SPONSORED_CHAIN_ID && i.killSwitch !== "0";
}

export const SPONSOR_UNAVAILABLE = "Free gas is unavailable right now: add MON or try later";

/** Thrown when Privy refuses to sponsor (policy, quota, chain not enabled). The write is NOT retried at the user's cost. */
export class SponsorError extends Error {
  constructor(readonly cause: unknown) {
    super(SPONSOR_UNAVAILABLE);
    this.name = "SponsorError";
  }
}

/** Does a sponsored send failure mean sponsorship itself was refused (rather than the user cancelling or the call reverting)? */
export function isSponsorRefusal(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /sponsor|paymaster|quota|spend(ing)? (limit|cap)|policy|insufficient funds|not enabled|gas (credit|balance)/i.test(m);
}
