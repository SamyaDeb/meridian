"use client";
// Passkey wallet UI (LAUNCH_PLAN §6 W1): log in with Face ID / fingerprint next to Privy's email login, using the same
// passkey as the native app (same rpId ⇒ same address). Only rendered when lib/mera/instance gives a wallet.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useConfig } from "wagmi";
import { Button, Dialog, Popover } from "@/components/ds";
import { connectPasskey } from "@/lib/mera/connector";
import { describePasskeyError } from "@/lib/mera/errors";
import { getPasskeyWallet } from "@/lib/mera/instance";
import type { PasskeyState, PasskeyWallet } from "@/lib/mera/wallet";
import { shortAddress } from "@/lib/format";
import { READ_CHAIN_ID } from "@/lib/wagmi";
import { useSession } from "./Session";
import { cta } from "./Wallet";
import { item } from "./nav/AccountMenu";

const LOCKED: PasskeyState = { status: "locked", addressHint: undefined, reason: "start" };
const noop = () => () => {};

/** The tab's passkey wallet and its state; [undefined, locked] when there is none (SSR, no rpId, wrong host). */
export function usePasskeyWallet(): [PasskeyWallet | undefined, PasskeyState] {
  // none on the server and during hydration (same markup both sides), the tab's wallet right after
  const wallet = useSyncExternalStore(noop, getPasskeyWallet, () => undefined);
  const state = useSyncExternalStore(wallet?.subscribe ?? noop, wallet?.getState ?? (() => LOCKED), () => LOCKED);
  return [wallet, state];
}

/** Idle and hidden-tab locks (mera-passkeys §5). Mounted once, in the header. */
export function usePasskeyLifecycle(): void {
  const [wallet] = usePasskeyWallet();
  useEffect(() => {
    if (!wallet) return;
    const touch = () => wallet.touch();
    const vis = () => wallet.setHidden(document.visibilityState === "hidden");
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    document.addEventListener("visibilitychange", vis);
    const t = setInterval(() => wallet.tick(), 15_000);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      document.removeEventListener("visibilitychange", vis);
      clearInterval(t);
    };
  }, [wallet]);
}

const LOCK_NOTE: Record<string, string> = {
  idle: "Locked after 10 minutes without activity.",
  hidden: "Locked while the tab was in the background.",
};

/** "Passkey" button: unlock the remembered passkey, sign in with any Meridian passkey (e.g. the phone's), or create one. */
export function PasskeyConnect() {
  const [wallet, state] = usePasskeyWallet();
  const config = useConfig();
  const { privyAuthenticated, logoutPrivy } = useSession();
  const [error, setError] = useState<string>();
  if (!wallet) return null;

  async function run(open: () => Promise<`0x${string}` | undefined>) {
    setError(undefined);
    // one login at a time: an email (Privy) session is ended before the passkey wallet takes over
    if (privyAuthenticated && logoutPrivy) await logoutPrivy().catch(() => undefined);
    const address = await open();
    if (!address) return;
    try {
      await connectPasskey(config, wallet!, READ_CHAIN_ID);
    } catch (e) {
      wallet!.lock();
      setError(describePasskeyError(e).message);
    }
  }

  if (state.status === "unlocking")
    return (
      <span role="status" className="text-[11px] text-muted">
        {state.step === "passkey" ? "Waiting for passkey…" : "Opening wallet…"}
      </span>
    );
  const hint = state.status === "locked" ? state.addressHint : undefined;
  const message = error ?? (state.status === "locked" ? (state.error ?? LOCK_NOTE[state.reason]) : undefined);
  return (
    <Popover label="Passkey wallet" triggerClassName={`${cta} bg-card-2 text-text hover:bg-border pointer-coarse:min-w-11`} trigger={hint ? `Unlock ${shortAddress(hint)}` : "Passkey"}>
      {(close) => (
        <div className="w-72 space-y-1">
          <p className="px-3 pt-2 text-xs text-muted">Face ID or fingerprint. Same wallet as the Meridian app on your phone. Your passkey is the key: Meridian never sees it.</p>
          {message && (
            <p role="alert" className="px-3 py-1 text-xs text-warn">
              {message}
            </p>
          )}
          {hint && (
            <button type="button" className={item} onClick={() => (close(), void run(() => wallet.unlock()))}>
              Unlock {shortAddress(hint)}
            </button>
          )}
          <button type="button" className={item} onClick={() => (close(), void run(() => wallet.unlock(true)))}>
            {hint ? "Use another passkey" : "Sign in with a passkey"}
          </button>
          <button type="button" className={item} onClick={() => (close(), void run(() => wallet.create(`Meridian ${new Date().toISOString().slice(0, 10)}`)))}>
            Create a passkey wallet
          </button>
          <p className="px-3 pb-2 text-[11px] text-muted">Passkey wallets pay their own gas in MON.</p>
        </div>
      )}
    </Popover>
  );
}

/** Account-menu entries for a passkey wallet: recovery phrase (fresh prompt; shown by the caller's dialog, outside the
 *  popover), lock, forget on this browser. */
export function PasskeyAccountActions({ onDone, onPhrase }: { onDone: () => void; onPhrase: (phrase: string) => void }) {
  const [wallet] = usePasskeyWallet();
  const [error, setError] = useState<string>();
  if (!wallet) return null;
  return (
    <>
      <button
        type="button"
        className={item}
        onClick={() => {
          setError(undefined);
          wallet.revealPhrase().then((p) => (onPhrase(p), onDone()), (e) => setError(describePasskeyError(e).message || "Couldn't use your passkey. Try again."));
        }}
      >
        Show recovery phrase
      </button>
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-warn">
          {error}
        </p>
      )}
      <button
        type="button"
        className={item}
        onClick={() => {
          wallet.lock();
          onDone();
        }}
      >
        Lock
      </button>
      <button
        type="button"
        className={`${item} text-short`}
        onClick={() => {
          wallet.forget();
          onDone();
        }}
      >
        Forget on this browser
      </button>
    </>
  );
}

export function RecoveryPhraseDialog({ phrase, onClose }: { phrase: string | undefined; onClose: () => void }) {
  const words = phrase?.split(" ") ?? [];
  return (
    <Dialog
      open={phrase !== undefined}
      onClose={onClose}
      title="Recovery phrase"
      footer={
        <Button variant="brand" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="text-xs text-warn">Anyone with these 24 words controls this wallet. Write them down offline; never paste them into a website.</p>
      <ol className="num mt-3 grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {words.map((w, i) => (
          <li key={i}>
            <span className="text-muted">{i + 1}.</span> {w}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-muted">Imports into MetaMask or Rabby as the same address.</p>
    </Dialog>
  );
}

/** Runs the idle / hidden-tab locks; renders nothing. */
export function PasskeyLifecycle() {
  usePasskeyLifecycle();
  return null;
}
