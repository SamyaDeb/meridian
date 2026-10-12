// Passkey wallet for one tab (LAUNCH_PLAN §6 W1, mera-passkeys §1 + §5). Owns the passkey ceremonies, the in-memory
// signing session, the lock rules and the credential record. React sees only the state (status + public address);
// the session and its key never enter React state or storage.
// Key path = the native app's: PRF → core deriveEvmKey (Mera's documented BIP-39/BIP-44 path, index 0) → Mera
// secp256k1 session → viem account, so the same passkey (same rpId) gives the same address on the phone and here.
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
  type WebAuthnClient,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { deriveEvmKey, recoveryPhrase } from "@meridian/core/keys";
import { isAddressEqual, type Address, type LocalAccount } from "viem";
import { describePasskeyError, WrongPasskeyError } from "./errors";
import { clearRecord, readRecord, writeRecord, type CredentialRecord, type KV } from "./record";

export type LockReason = "start" | "idle" | "hidden" | "manual" | "forgot" | "failed";

export type PasskeyState =
  | { status: "locked"; addressHint: Address | undefined; reason: LockReason; error?: string }
  | { status: "unlocking"; addressHint: Address | undefined; step: "passkey" | "deriving" }
  | { status: "unlocked"; address: Address };

/** mera-passkeys §5 / MOBILE_PLAN N3: lock after 10 min without input, or after 5 min with the tab hidden. */
export const IDLE_LOCK_MS = 10 * 60_000;
export const HIDDEN_LOCK_MS = 5 * 60_000;

export type PasskeyWalletDeps = {
  rpId: string;
  kv?: KV | undefined;
  /** undefined ⇒ Mera's built-in browser client (navigator.credentials) */
  webAuthnClient?: WebAuthnClient | undefined;
  now?: () => number;
  idleMs?: number;
  hiddenMs?: number;
  /** let the UI paint "Opening wallet…" before the synchronous PBKDF2 in the derivation blocks the thread */
  yieldToPaint?: () => Promise<void>;
};

type Signer = { session: Secp256k1SigningSession; account: LocalAccount };

/** Takes ownership of `prf`: it and our copy of the key are zeroed before this returns (the session keeps its own). */
function openSigner(prf: Uint8Array): Signer {
  let key: Uint8Array | undefined;
  try {
    key = deriveEvmKey(prf, 0);
    const session = createSecp256k1SigningSession({ privateKey: key });
    try {
      return { session, account: toViemAccount(session) };
    } catch (e) {
      session.end();
      throw e;
    }
  } finally {
    key?.fill(0);
    prf.fill(0);
  }
}

const metaOf = (r: CredentialRecord): PasskeyCredentialMetadata => ({
  credentialId: r.credentialId,
  ...(r.transports ? { transports: r.transports as PasskeyCredentialMetadata["transports"] } : {}),
});

export class PasskeyWallet {
  private state: PasskeyState;
  private readonly listeners = new Set<() => void>();
  private signer: Signer | undefined;
  /** the passkey behind the open session (kept even when storage is unavailable, for the phrase re-prompt) */
  private credential: PasskeyCredentialMetadata | undefined;
  private lastActivity = 0;
  private hiddenAt: number | undefined;
  private busy = false;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly hiddenMs: number;

  constructor(private readonly d: PasskeyWalletDeps) {
    this.now = d.now ?? Date.now;
    this.idleMs = d.idleMs ?? IDLE_LOCK_MS;
    this.hiddenMs = d.hiddenMs ?? HIDDEN_LOCK_MS;
    this.state = { status: "locked", addressHint: readRecord(d.kv)?.addressHint, reason: "start" };
  }

  getState = (): PasskeyState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(s: PasskeyState): void {
    this.state = s;
    for (const fn of this.listeners) fn();
  }

  /** The signing account while unlocked. Never stored by callers beyond one write. */
  account(): LocalAccount | undefined {
    return this.signer?.account;
  }

  /** New passkey on this rpId + its wallet. */
  create(displayName: string): Promise<Address | undefined> {
    return this.open(async () => {
      const r = await createPasskeyWithPrfOutput({ rp: { id: this.d.rpId, name: "Meridian" }, user: { name: displayName, displayName }, ...this.client() });
      return { prf: r.prfOutput, credential: { credentialId: r.credentialId, ...(r.transports ? { transports: r.transports } : {}) } };
    });
  }

  /** The remembered passkey, or (`any`, or nothing remembered) whichever Meridian passkey the user picks, e.g. the one made on the phone. */
  unlock(any = false): Promise<Address | undefined> {
    const rec = any ? undefined : readRecord(this.d.kv);
    return this.open(async () => {
      const r = await getPasskeyPrfOutput({ rpId: this.d.rpId, ...(rec ? { credential: metaOf(rec) } : {}), ...this.client() });
      const credential = rec?.credentialId === r.credentialId ? metaOf(rec) : { credentialId: r.credentialId };
      return { prf: r.prfOutput, credential };
    });
  }

  private client() {
    return this.d.webAuthnClient ? { webAuthnClient: this.d.webAuthnClient } : {};
  }

  private async open(ceremony: () => Promise<{ prf: Uint8Array; credential: PasskeyCredentialMetadata }>): Promise<Address | undefined> {
    if (this.busy || this.state.status === "unlocked") return this.state.status === "unlocked" ? this.state.address : undefined;
    this.busy = true;
    const addressHint = this.state.status === "locked" ? this.state.addressHint : undefined;
    this.set({ status: "unlocking", addressHint, step: "passkey" });
    try {
      const { prf, credential } = await ceremony();
      this.set({ status: "unlocking", addressHint, step: "deriving" });
      await this.d.yieldToPaint?.();
      const signer = openSigner(prf);
      this.signer = signer;
      this.credential = credential;
      this.lastActivity = this.now();
      this.hiddenAt = undefined;
      const address = signer.account.address;
      writeRecord(this.d.kv, { credentialId: credential.credentialId, ...(credential.transports ? { transports: [...credential.transports] } : {}), createdAt: this.now(), addressHint: address });
      this.set({ status: "unlocked", address });
      return address;
    } catch (e) {
      const { message } = describePasskeyError(e);
      this.set({ status: "locked", addressHint, reason: "failed", ...(message ? { error: message } : {}) });
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /** Ends the session (the key is zeroed by Mera). The address stays as a hint for the next unlock. */
  lock(reason: Exclude<LockReason, "start" | "failed" | "forgot"> = "manual"): void {
    if (this.state.status !== "unlocked") return;
    const address = this.state.address;
    this.endSession();
    this.set({ status: "locked", addressHint: address, reason });
  }

  /** Lock and forget which passkey this browser used (the passkey itself stays in the user's password manager). */
  forget(): void {
    this.endSession();
    clearRecord(this.d.kv);
    this.credential = undefined;
    this.set({ status: "locked", addressHint: undefined, reason: "forgot" });
  }

  private endSession(): void {
    this.signer?.session.end();
    this.signer = undefined;
  }

  /** User input seen: pushes the idle lock back. */
  touch(): void {
    if (this.state.status === "unlocked") this.lastActivity = this.now();
  }

  setHidden(hidden: boolean): void {
    if (hidden) {
      this.hiddenAt ??= this.now();
      return;
    }
    this.tick(); // judge the time spent hidden before forgetting it
    this.hiddenAt = undefined;
  }

  /** Called on a timer and on visibility changes: locks once idle or hidden for too long. */
  tick(): void {
    if (this.state.status !== "unlocked") return;
    const t = this.now();
    if (this.hiddenAt !== undefined && t - this.hiddenAt > this.hiddenMs) this.lock("hidden");
    else if (t - this.lastActivity >= this.idleMs) this.lock("idle");
  }

  /**
   * The 24-word recovery phrase (imports into MetaMask / Rabby as the same address). Always a fresh passkey prompt,
   * even while unlocked (mera-passkeys §5), and only for the passkey of the open wallet. Throws on failure.
   */
  async revealPhrase(): Promise<string> {
    if (this.state.status !== "unlocked" || !this.credential) throw new Error("Unlock the wallet first.");
    const address = this.state.address;
    const r = await getPasskeyPrfOutput({ rpId: this.d.rpId, credential: this.credential, ...this.client() });
    const prf = r.prfOutput;
    try {
      // address through a throwaway session (no hex copy of the key that can't be wiped)
      const check = openSigner(prf.slice());
      const derived = check.account.address;
      check.session.end();
      if (!isAddressEqual(derived, address)) throw new WrongPasskeyError();
      this.touch();
      return recoveryPhrase(prf);
    } finally {
      prf.fill(0);
    }
  }
}
