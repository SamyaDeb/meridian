// Owns the wallet for one app run: the passkey ceremonies, the in-memory signer, the lock timers and the credential
// record. React sees only `store` (status + public address) and `stats`; the signer never enters React state.
import type { WebAuthnClient } from "@category-labs/mera";
import { recoveryPhrase } from "@meridian/core/keys";
import type { LocalAccount } from "viem";
import type { AppEnv } from "../config/appConfig";
import { Store } from "../live/store";
import { CredentialStore, type CredentialRecord, type KV } from "./credentialStore";
import { defaultDeriveDeps, openSigner, type DeriveDeps, type Signer } from "./derive";
import { describeAuthError, RpGuardError, WrongPasskeyError, type AuthError } from "./errors";
import { createPasskey, getPrf, type PasskeyDeps } from "./passkey";
import { rpIdProblem } from "./rpGuard";
import { backgroundExpired, BACKGROUND_LOCK_MS, IDLE_LOCK_MS, idleExpired, INITIAL, reduce, type AuthEvent, type AuthState, type LockReason } from "./session";

export type AuthClock = {
  now(): number;
  every(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
  /** let the UI paint (e.g. "Unlocking…") before the synchronous key derivation blocks the JS thread */
  nextFrame(): Promise<void>;
};

export const realClock: AuthClock = {
  now: () => Date.now(),
  every: (ms, fn) => setInterval(fn, ms),
  cancel: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  nextFrame: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
};

export type AuthDeps = {
  cfg: { env: AppEnv; rpId: string; androidPackage: string };
  kv: KV;
  webAuthnClient: WebAuthnClient;
  clock?: AuthClock;
  derive?: DeriveDeps;
  idleMs?: number;
  backgroundMs?: number;
};

export class LockedError extends Error {
  constructor() {
    super("Meridian is locked. Unlock with your passkey.");
    this.name = "LockedError";
  }
}

export type AuthStats = { deriveMs: number | undefined };

export class AuthController {
  readonly store = new Store<AuthState>(INITIAL);
  readonly stats = new Store<AuthStats>({ deriveMs: undefined });
  private signer: Signer | undefined;
  private record: CredentialRecord | undefined;
  private creds: CredentialStore;
  private clock: AuthClock;
  private derive: DeriveDeps;
  private passkey: PasskeyDeps;
  private idleMs: number;
  private backgroundMs: number;
  private lastActivity = 0;
  private backgroundedAt: number | undefined;
  private ticker: unknown;
  private firstPasskeyCall = true;
  private busy = false;

  constructor(private d: AuthDeps) {
    this.creds = new CredentialStore(d.kv, d.cfg.rpId);
    this.clock = d.clock ?? realClock;
    this.derive = d.derive ?? defaultDeriveDeps;
    this.passkey = { rpId: d.cfg.rpId, webAuthnClient: d.webAuthnClient };
    this.idleMs = d.idleMs ?? IDLE_LOCK_MS;
    this.backgroundMs = d.backgroundMs ?? BACKGROUND_LOCK_MS;
  }

  private dispatch(e: AuthEvent): void {
    this.store.set(reduce(this.store.get(), e));
  }

  /** undefined = passkeys allowed for this build */
  get rpProblem(): string | undefined {
    return rpIdProblem(this.d.cfg);
  }

  async init(): Promise<void> {
    this.record = await this.creds.read();
    this.dispatch({ type: "LOADED", addressHint: this.record?.addressHint });
  }

  /** Create a new passkey wallet (prompt), store its credential record, unlock. */
  async create(displayName = "Meridian wallet"): Promise<void> {
    await this.ceremony(async () => {
      const h = await createPasskey(this.passkey, displayName);
      const signer = await this.open(h.prf);
      try {
        await this.saveRecord({ credentialId: h.credential.credentialId, ...(h.credential.transports ? { transports: [...h.credential.transports] } : {}), createdAt: this.clock.now(), addressHint: signer.address });
      } catch (e) {
        signer.session.end();
        throw e;
      }
      return signer;
    });
  }

  /** Unlock with the stored passkey; `pick` (or no record) lets the user choose any Meridian passkey (new phone). */
  async unlock(opts: { pick?: boolean } = {}): Promise<void> {
    await this.ceremony(async () => {
      const stored = opts.pick ? undefined : this.record;
      const h = await getPrf(this.passkey, stored ? { credentialId: stored.credentialId, ...(stored.transports ? { transports: stored.transports } : {}) } : undefined);
      const signer = await this.open(h.prf);
      if (!stored || this.record?.credentialId !== h.credential.credentialId) {
        try {
          await this.saveRecord({ credentialId: h.credential.credentialId, ...(h.credential.transports ? { transports: [...h.credential.transports] } : {}), createdAt: this.clock.now(), addressHint: signer.address });
        } catch (e) {
          signer.session.end();
          throw e;
        }
      }
      return signer;
    });
  }

  private async ceremony(run: () => Promise<Signer>): Promise<void> {
    if (this.busy) return;
    const problem = this.rpProblem;
    if (problem) throw new RpGuardError(problem);
    const s = this.store.get();
    if (s.status !== "locked") return;
    this.busy = true;
    this.dispatch({ type: "UNLOCK_START" });
    try {
      const signer = await run();
      this.begin(signer);
    } catch (e) {
      this.dispatch({ type: "UNLOCK_FAIL" });
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /** PRF → signer, after letting the UI paint "Unlocking…" (the derivation is synchronous). Wipes the PRF. */
  private async open(prf: Uint8Array): Promise<Signer> {
    this.firstPasskeyCall = false;
    this.dispatch({ type: "DERIVING" });
    try {
      await this.clock.nextFrame();
    } catch (e) {
      prf.fill(0);
      throw e;
    }
    const s = openSigner(prf, this.derive);
    this.stats.set({ deriveMs: s.deriveMs });
    return { session: s.session, account: s.account, address: s.address };
  }

  private async saveRecord(r: CredentialRecord): Promise<void> {
    await this.creds.write(r);
    this.record = r;
  }

  private begin(signer: Signer): void {
    this.signer = signer;
    this.lastActivity = this.clock.now();
    this.backgroundedAt = undefined;
    this.dispatch({ type: "UNLOCK_OK", address: signer.address });
    if (this.ticker === undefined) this.ticker = this.clock.every(Math.min(15_000, this.idleMs), () => this.checkIdle());
  }

  /** End the session (zeroes the key) and go to LOCKED. */
  lock(reason: "idle" | "background" | "manual" = "manual"): void {
    this.endSigner();
    this.dispatch({ type: "LOCK", reason });
  }

  private endSigner(): void {
    this.signer?.session.end();
    this.signer = undefined;
    if (this.ticker !== undefined) this.clock.cancel(this.ticker);
    this.ticker = undefined;
  }

  /** Lock + forget the credential record (the passkey itself stays in the user's password manager). */
  async signOut(): Promise<void> {
    this.endSigner();
    this.record = undefined;
    await this.creds.clear();
    this.dispatch({ type: "SIGNED_OUT" });
  }

  /** Any touch counts as activity. */
  touch(): void {
    if (this.signer) this.lastActivity = this.clock.now();
  }

  checkIdle(): void {
    if (this.signer && idleExpired(this.lastActivity, this.clock.now(), this.idleMs)) this.lock("idle");
  }

  /** AppState: background starts the clock; coming back after > backgroundMs (or idle) locks. */
  onAppState(next: string): void {
    if (next === "background") {
      this.backgroundedAt ??= this.clock.now();
      return;
    }
    if (next === "active") {
      const expired = backgroundExpired(this.backgroundedAt, this.clock.now(), this.backgroundMs);
      this.backgroundedAt = undefined;
      if (expired && this.signer) this.lock("background");
      else this.checkIdle();
    }
  }

  /** The unlocked account (signs with the in-memory session). */
  account(): LocalAccount {
    if (!this.signer) throw new LockedError();
    return this.signer.account;
  }

  /**
   * Fresh passkey prompt for a value-moving or sensitive action: `fn` gets the PRF of THIS wallet's passkey, which is
   * zeroed when `fn` settles. Another passkey answering → WrongPasskeyError.
   */
  async withFreshPrf<T>(fn: (prf: Uint8Array) => T | Promise<T>): Promise<T> {
    const r = this.record;
    if (!this.signer || !r) throw new LockedError();
    const h = await getPrf(this.passkey, { credentialId: r.credentialId, ...(r.transports ? { transports: r.transports } : {}) });
    try {
      if (h.credential.credentialId !== r.credentialId) throw new WrongPasskeyError();
      return await fn(h.prf);
    } finally {
      h.prf.fill(0);
    }
  }

  /** Per-transaction signer from a fresh prompt; ended as soon as `fn` settles (withdraw, Perpl deposit). */
  async withFreshSession<T>(fn: (account: LocalAccount) => Promise<T>): Promise<T> {
    const want = this.signer?.address;
    return this.withFreshPrf(async (prf) => {
      const s = openSigner(Uint8Array.from(prf), this.derive);
      try {
        if (s.address !== want) throw new WrongPasskeyError();
        return await fn(s.account);
      } finally {
        s.session.end();
      }
    });
  }

  /** Recovery phrase behind a fresh prompt. The words are returned once; the caller shows them and drops them. */
  async exportRecoveryPhrase(): Promise<string[]> {
    return this.withFreshPrf((prf) => recoveryPhrase(prf).split(" "));
  }

  describe(e: unknown): AuthError {
    return describeAuthError(e, { firstPasskeyCall: this.firstPasskeyCall, rpId: this.d.cfg.rpId, androidPackage: this.d.cfg.androidPackage });
  }

  get hasRecord(): boolean {
    return this.record !== undefined;
  }

  /** test/dev introspection: is a signer alive? */
  get isUnlocked(): boolean {
    return this.signer !== undefined;
  }
}

export type { LockReason };
