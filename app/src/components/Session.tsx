"use client";
// What the write path and the CTAs need from the auth layer, without importing the Privy SDK (decision D6): the Privy
// build fills it from PrivySponsorBridge (components/PrivyControls.tsx); every other build uses the default.
import { createContext, useContext } from "react";
import { useConnect } from "wagmi";
import type { SponsoredSend } from "@/lib/tx";
import type { WalletKind } from "@/lib/sponsor";

export type Session = {
  /** true inside PrivyProvider */
  privy: boolean;
  /** kind of the wallet wagmi is using; undefined while Privy's wallet list loads (or without Privy) */
  walletKind: WalletKind | undefined;
  /** Privy `sendTransaction(…, { sponsor: true })` for the embedded wallet */
  sponsoredSend: SponsoredSend | undefined;
  /** opens Privy's login modal */
  login: (() => void) | undefined;
  loginError: string | undefined;
};

const DEFAULT: Session = { privy: false, walletKind: undefined, sponsoredSend: undefined, login: undefined, loginError: undefined };
export const SessionContext = createContext<Session>(DEFAULT);
export const useSession = (): Session => useContext(SessionContext);

/** "Start trading" / "Log in": Privy's modal when Privy is on, else the anvil dev account, else the injected wallet. */
export function useStartLogin(): (() => void) | undefined {
  const { login } = useSession();
  const { connectors, connect } = useConnect();
  if (login) return login;
  const c = connectors.find((x) => x.type === "mock") ?? connectors.find((x) => x.type === "injected");
  return c ? () => connect({ connector: c }) : undefined;
}
