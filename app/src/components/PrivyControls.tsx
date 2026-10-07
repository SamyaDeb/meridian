"use client";
// Privy login / account controls and the sponsorship bridge (decision D6, K1). Imported with next/dynamic (or from
// PrivyProviders) only when NEXT_PUBLIC_PRIVY_APP_ID is set, so they always render inside PrivyProvider and the SDK never
// ships in a build without the app ID. Hooks used here exist in @privy-io/react-auth 3.47.0's types.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { useExportWallet, useLogin, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { deriveLoginState, walletKindOf } from "@/lib/login";
import { privyEnabled } from "@/lib/privy";
import { shortAddress } from "@/lib/format";
import type { SponsoredSend } from "@/lib/tx";
import { SessionContext, useSession } from "./Session";
import { cta } from "./Wallet";
import { item } from "./nav/AccountMenu";

/** Provides the Session (wallet kind, sponsored sender, login) to everything below PrivyProvider + Privy's WagmiProvider. */
export function PrivySponsorBridge({ children }: { children: ReactNode }) {
  const { wallets } = useWallets();
  const { address } = useAccount();
  const { sendTransaction } = useSendTransaction();
  const [loginError, setLoginError] = useState<string>();
  const { login } = useLogin({ onError: (e) => setLoginError(String(e)), onComplete: () => setLoginError(undefined) });
  const active = address ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase()) : undefined;
  const walletKind = walletKindOf(active?.walletClientType);
  // App-initiated writes the user already tapped through a labelled button with a preview: Privy's own confirm screen
  // would only repeat it, so wallet UIs are off for sponsored sends (uiOptions.showWalletUIs, SendTransactionModalUIOptions).
  const sponsoredSend = useCallback<SponsoredSend>(
    async (c) =>
      (
        await sendTransaction(
          { from: c.from, to: c.to, data: c.data, value: c.value, gasLimit: c.gas, chainId: c.chainId },
          { sponsor: true, address: c.from, uiOptions: { showWalletUIs: false } },
        )
      ).hash,
    [sendTransaction],
  );
  const value = useMemo(
    () => ({ privy: true, walletKind, sponsoredSend, login: () => login(), loginError }),
    [walletKind, sponsoredSend, login, loginError],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function PrivyConnect() {
  const { ready, authenticated } = usePrivy();
  const { address, isConnected } = useAccount();
  const { login, loginError, walletKind } = useSession();
  const state = deriveLoginState({ privyEnabled, ready, authenticated, walletAddress: isConnected ? address : undefined, walletKind, error: loginError });
  if (state.kind === "ready") return <span className="num text-[11px] text-muted">{shortAddress(state.address)}</span>;
  if (state.kind === "loading" || state.kind === "creating-wallet")
    return (
      <span role="status" className="text-[11px] text-muted">
        {state.kind === "loading" ? "Loading…" : "Creating wallet…"}
      </span>
    );
  return (
    <div className="flex items-center gap-2">
      {state.kind === "error" && (
        <span role="alert" className="text-[11px] text-warn">
          Login failed
        </span>
      )}
      <button type="button" onClick={() => login?.()} className={`${cta} bg-brand text-on-brand hover:bg-brand-hover pointer-coarse:min-w-11`}>
        Log in
      </button>
    </div>
  );
}

/** Account-menu entries under Privy: export the embedded wallet's key (Privy's own secure modal), then log out. The
 *  session (login + embedded wallet) is ended by Privy's logout, not by a wagmi disconnect. */
export function PrivyAccountActions({ onDone }: { onDone: () => void }) {
  const { logout } = usePrivy();
  const { exportWallet } = useExportWallet();
  const { disconnect } = useDisconnect();
  const { address } = useAccount();
  const { walletKind } = useSession();
  return (
    <>
      {walletKind === "embedded" && address && (
        <button
          type="button"
          className={item}
          onClick={() => {
            onDone();
            void exportWallet({ address }).catch(() => undefined);
          }}
        >
          Export wallet
        </button>
      )}
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
    </>
  );
}
