"use client";
// Privy login / account controls and the sponsorship bridge (decision D6, K1). Imported with next/dynamic (or from
// PrivyProviders) only when NEXT_PUBLIC_PRIVY_APP_ID is set, so they always render inside PrivyProvider and the SDK never
// ships in a build without the app ID. Hooks used here exist in @privy-io/react-auth 3.47.0's types.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { useCreateWallet, useExportWallet, useLogin, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { deriveLoginState, walletKindOf } from "@/lib/login";
import { privyEnabled } from "@/lib/privy";
import { PASSKEY_CONNECTOR_TYPE } from "@/lib/mera/connector";
import { shortAddress } from "@/lib/format";
import type { SponsoredSend } from "@/lib/tx";
import { SessionContext, useSession } from "./Session";
import { cta } from "./Wallet";
import { item } from "./nav/AccountMenu";

/** Provides the Session (wallet kind, sponsored sender, login) to everything below PrivyProvider + Privy's WagmiProvider. */
export function PrivySponsorBridge({ children }: { children: ReactNode }) {
  const { wallets, ready: walletsReady } = useWallets();
  const { address, connector } = useAccount();
  const { authenticated, logout, user } = usePrivy();
  const { setActiveWallet } = useSetActiveWallet();
  const { createWallet } = useCreateWallet();
  // Logged in but no wallet reached wagmi ("Creating wallet…" that never ends). Two known ways in: Privy holds a wallet
  // that wagmi never picked up (activate it, embedded first), or the account has no embedded wallet at all because it
  // was first made with an external wallet (createOnLogin only covers users without ANY wallet): create one, once.
  const createTried = useRef(false);
  const hasEmbedded = Boolean(user?.linkedAccounts.some((a) => a.type === "wallet" && a.walletClientType === "privy"));
  useEffect(() => {
    if (!authenticated || !walletsReady || address) return;
    const t = setTimeout(() => {
      const pick = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (pick) void setActiveWallet(pick).catch(() => undefined);
      else if (!hasEmbedded && !createTried.current) {
        createTried.current = true;
        void createWallet().catch(() => undefined);
      }
    }, 3_000); // the normal sync lands well inside this
    return () => clearTimeout(t);
  }, [authenticated, walletsReady, address, wallets, hasEmbedded, setActiveWallet, createWallet]);
  const { sendTransaction } = useSendTransaction();
  const [loginError, setLoginError] = useState<string>();
  const { login } = useLogin({ onError: (e) => setLoginError(String(e)), onComplete: () => setLoginError(undefined) });
  const active = address ? wallets.find((w) => w.address.toLowerCase() === address.toLowerCase()) : undefined;
  const walletKind = connector?.type === PASSKEY_CONNECTOR_TYPE ? "passkey" : walletKindOf(active?.walletClientType);
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
    () => ({ privy: true, walletKind, sponsoredSend, login: () => login(), loginError, privyAuthenticated: authenticated, logoutPrivy: logout }),
    [walletKind, sponsoredSend, login, loginError, authenticated, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function PrivyConnect() {
  const { ready, authenticated } = usePrivy();
  const { address, isConnected } = useAccount();
  const { login, loginError, walletKind, logoutPrivy } = useSession();
  const state = deriveLoginState({ privyEnabled, ready, authenticated, walletAddress: isConnected ? address : undefined, walletKind, error: loginError });
  // still no wallet after the recovery in PrivySponsorBridge had its turn: say so instead of spinning forever
  const waiting = state.kind === "creating-wallet";
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setStuck(true), 15_000);
    return () => {
      clearTimeout(t);
      setStuck(false);
    };
  }, [waiting]);
  if (state.kind === "ready") return <span className="num text-[11px] text-muted">{shortAddress(state.address)}</span>;
  if (state.kind === "loading" || state.kind === "creating-wallet")
    return (
      <span className="flex items-center gap-2 text-[11px] text-muted">
        <span role="status" title={stuck ? "Reload the page, or log out and log in again. If it repeats, allow cross-site storage for this site (the wallet runs in a Privy frame)." : undefined}>
          {state.kind === "loading" ? "Loading…" : stuck ? "Wallet didn't load" : "Creating wallet…"}
        </span>
        {/* logged in but no wallet has reached wagmi (an external wallet that is locked or on another account never
            will): without this there is no way out, the account menu only exists once a wallet is connected */}
        {state.kind === "creating-wallet" && (
          <button type="button" onClick={() => void logoutPrivy?.()} className="underline hover:text-text">
            Log out
          </button>
        )}
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
