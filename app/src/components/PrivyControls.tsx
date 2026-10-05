"use client";
// Privy login / logout controls (decision D6). Imported with next/dynamic only when NEXT_PUBLIC_PRIVY_APP_ID is set, so
// they always render inside PrivyProvider and the SDK never ships in a build without the app ID.
import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { deriveLoginState } from "@/lib/login";
import { privyEnabled } from "@/lib/privy";
import { shortAddress } from "@/lib/format";
import { cta } from "./Wallet";
import { item } from "./nav/AccountMenu";

export function PrivyConnect() {
  const { ready, authenticated } = usePrivy();
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const [error, setError] = useState<string>();
  const { login } = useLogin({ onError: (e) => setError(String(e)), onComplete: () => setError(undefined) });
  const state = deriveLoginState({ privyEnabled, ready, authenticated, walletAddress: isConnected ? address : undefined, error });
  if (state.kind === "ready") return <span className="num text-[11px] text-muted">{shortAddress(state.address)}</span>;
  if (state.kind === "loading" || state.kind === "creating-wallet")
    return <span className="text-[11px] text-muted">{state.kind === "loading" ? "Loading…" : "Creating wallet…"}</span>;
  const injected = connectors.find((c) => c.type === "injected");
  return (
    <div className="flex items-center gap-2">
      {state.kind === "error" && (
        <span role="alert" className="text-[11px] text-warn">
          Login failed
        </span>
      )}
      <button type="button" onClick={() => login({ loginMethods: ["email"] })} className={`${cta} bg-brand text-on-brand hover:bg-brand-hover`}>
        Log in
      </button>
      {injected && (
        <button type="button" onClick={() => connect({ connector: injected })} className={`${cta} bg-card-2 text-text hover:bg-border`}>
          Wallet
        </button>
      )}
    </div>
  );
}

/** With Privy the session (email login + embedded wallet) is ended by Privy's logout, not by a wagmi disconnect.
 *  Only rendered when NEXT_PUBLIC_PRIVY_APP_ID is set, i.e. inside PrivyProvider. */
export function PrivyLogout({ onDone }: { onDone: () => void }) {
  const { logout } = usePrivy();
  const { disconnect } = useDisconnect();
  return (
    <button
      type="button"
      className={`${item} text-short`}
      onClick={() => {
        void logout().finally(() => disconnect());
        onDone();
      }}
    >
      Log out
    </button>
  );
}
