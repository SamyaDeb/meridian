// Login state machine (pure). Privy gives us ready/authenticated/wallet; the UI needs one label per situation.
export type LoginInput = {
  /** NEXT_PUBLIC_PRIVY_APP_ID present */
  privyEnabled: boolean;
  /** Privy SDK finished initialising */
  ready: boolean;
  authenticated: boolean;
  /** embedded (or linked) wallet address wagmi sees */
  walletAddress: string | undefined;
  /** last login/signature failure, if any */
  error: string | undefined;
};

export type LoginState =
  | { kind: "injected-only" }
  | { kind: "loading" }
  | { kind: "logged-out" }
  | { kind: "creating-wallet" }
  | { kind: "ready"; address: string }
  | { kind: "error"; message: string };

export function deriveLoginState(i: LoginInput): LoginState {
  if (!i.privyEnabled) return { kind: "injected-only" };
  if (!i.ready) return { kind: "loading" };
  if (i.error && !i.authenticated) return { kind: "error", message: i.error };
  if (!i.authenticated) return { kind: "logged-out" };
  if (!i.walletAddress) return { kind: "creating-wallet" };
  return { kind: "ready", address: i.walletAddress };
}

/** User-visible message for a failed signature/login (rejection is normal, not an error to shout about). */
export function describeSignError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(m)) return "Signature cancelled";
  if ((e as { code?: string })?.code === "wrong-chain") return "Wrong network: switch to Monad and retry";
  if ((e as { code?: string })?.code === "deadline-expired") return "Permit expired: try again";
  return m.split("\n")[0] ?? m;
}
