// Perpl onboarding for the unlocked wallet (MOBILE_PLAN N4 §2–§3): detect → enrol key → deposit (approve exact +
// createAccount, or depositCollateral to top up) → allowOrderForwarding(true). Every step is re-detected afterwards;
// nothing about progress is stored locally except the API-key record (tokenStore). Network, chain and signing are
// injected (`OnboardingDeps`), so the whole flow runs offline in tests against core fakes.
//
// Txs: value-moving ones (approve + createAccount / depositCollateral) run inside ONE fresh passkey prompt
// (auth.withFreshSession); allowOrderForwarding uses the unlocked session. All through N3's sendTx (estimate × 1.2,
// pending nonce, EIP-1559, explicit chain, receipt, decoded reverts).
import {
  PerplHttpError,
  accountByAddrRead,
  allowForwardingTx,
  approveCollateralTx,
  createAccountTx,
  createSignedRest,
  depositCollateralTx,
  enrollApiKey,
  explainHttp,
  minAccountOpenRead,
  observeWallet,
  type SignedRest,
} from "@meridian/core/perpl";
import type { PerplDeployment } from "@meridian/core/meridian";
import type { FetchLike, RandomBytes } from "@meridian/core/util";
import { erc20Abi, type Address, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import type { PerplKeyView } from "../../auth/controller";
import { Store } from "../../live/store";
import type { TxRequest, TxResult } from "../../wallet/sendTx";
import { checkDeposit, needsApprove, parseAmountUp } from "./amounts";
import { onboardingView, type ChainAccount, type OnboardingView } from "./onboardingModel";
import { MAX_ROTATION, type PerplKeyRecord, type PerplTokenStore } from "./tokenStore";

/** The chain reads onboarding needs (a viem PublicClient satisfies it). */
export type ChainReader = {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

export type OnboardingAuth = {
  account(): LocalAccount;
  perplKey(): PerplKeyView | undefined;
  rekeyPerpl(fromRotation: number, tryEnroll: (key: PerplKeyView) => Promise<boolean>): Promise<PerplKeyView>;
  withFreshSession<T>(fn: (account: LocalAccount) => Promise<T>): Promise<T>;
};

export type OnboardingDeps = {
  deployment: PerplDeployment;
  chainId: number;
  address: Address;
  auth: OnboardingAuth;
  tokens: PerplTokenStore;
  chain: ChainReader;
  /** send one tx with the given account (N3 sendTx bound to the app's public client + chain) */
  sendWith: (account: LocalAccount, req: TxRequest) => Promise<TxResult>;
  fetchFn: FetchLike;
  random: RandomBytes;
  now: () => number;
  /** API-key label shown in Perpl's key list */
  label?: string;
};

export type StepName = "enroll" | "approve" | "createAccount" | "deposit" | "forwarding";
export type StepTx = { step: StepName; hash: Hex; blockNumber: bigint; gasUsed: bigint; gasLimit: bigint };

export type OnboardingState = {
  view: OnboardingView | undefined;
  /** getMinAccountOpenCNS(), collateral token units (read before every createAccount) */
  minOpen: bigint | undefined;
  /** collateral in the wallet / approved to the exchange, token units */
  walletBalance: bigint | undefined;
  allowance: bigint | undefined;
  record: Pick<PerplKeyRecord, "rotation" | "publicKeyHex" | "enrolledAt"> | undefined;
  busy: StepName | "refresh" | undefined;
  error: string | undefined;
  txs: StepTx[];
  enrollNeedsAccount: boolean;
  refreshedAt: number | undefined;
};

const INITIAL: OnboardingState = { view: undefined, minOpen: undefined, walletBalance: undefined, allowance: undefined, record: undefined, busy: undefined, error: undefined, txs: [], enrollNeedsAccount: false, refreshedAt: undefined };

/** Plain words for an enrolment HTTP failure (integrations.md "Enroll status codes"). */
export function explainEnroll(status: number): string {
  if (status === 404) return "Perpl doesn't know this wallet yet. Open your Perpl account with a deposit first, then enable trading.";
  if (status === 409) return "This trading key is already registered. Making a new one…";
  if (status === 423) return "Your wallet already has 16 active Perpl keys. Revoke one at Perpl → API keys, then try again.";
  if (status === 400) return "Perpl refused the request (400). Try again; if it repeats, Perpl may need to allow this app.";
  return explainHttp(status);
}

export class PerplOnboarding {
  readonly store = new Store<OnboardingState>(INITIAL);
  private record: PerplKeyRecord | undefined;
  private decimalsChecked = false;

  constructor(private d: OnboardingDeps) {}

  /** collateral token decimals (deployments/perpl.json; refresh() refuses to go on if the token says otherwise) */
  get collateralDecimals(): number {
    return this.d.deployment.collateralDecimals;
  }

  private get exchange(): Address {
    return this.d.deployment.exchange;
  }

  /** Signed REST for the stored token + the session's key; undefined when either is missing. */
  signedRest(): SignedRest | undefined {
    const key = this.d.auth.perplKey();
    const r = this.record;
    if (!key || !r || key.rotation !== r.rotation || key.publicKeyHex !== r.publicKeyHex) return undefined;
    return createSignedRest({ apiUrl: this.d.deployment.apiUrl, chainId: this.d.chainId, apiKey: r.token, secret: key.signer, fetchFn: this.d.fetchFn, random: this.d.random });
  }

  /** the stored token, for the trading socket (never logged) */
  token(): string | undefined {
    return this.record?.token;
  }

  private async readChainAccount(): Promise<ChainAccount | null> {
    try {
      const a = (await this.d.chain.readContract(accountByAddrRead(this.exchange, this.d.address) as never)) as { accountId: bigint; balanceCNS: bigint; lockedBalanceCNS: bigint };
      return a.accountId > 0n ? { id: a.accountId, balanceCns: a.balanceCNS, lockedCns: a.lockedBalanceCNS } : null;
    } catch (e) {
      // README "Checking Account Status": getAccountByAddr reverts when the wallet has no account
      if (isRevert(e)) return null;
      throw e;
    }
  }

  /** Detect everything from Perpl + chain. Safe to call on launch, unlock, foreground and after each step. */
  async refresh(): Promise<OnboardingView> {
    this.store.update({ busy: this.store.get().busy ?? "refresh" });
    try {
      this.record = await this.d.tokens.read(this.d.chainId, this.d.address);
      const token = this.collateral();
      if (!this.decimalsChecked) {
        const onChain = Number(await this.d.chain.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
        if (onChain !== this.d.deployment.collateralDecimals) throw new UserFacingError(`Perpl collateral reports ${onChain} decimals, config says ${this.d.deployment.collateralDecimals}. Not continuing.`);
        this.decimalsChecked = true;
      }
      const [chainAccount, wallet, walletBalance, allowance] = await Promise.all([
        this.readChainAccount(),
        observeWallet(this.signedRest()),
        this.d.chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.d.address] }) as Promise<bigint>,
        this.d.chain.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.d.address, this.exchange] }) as Promise<bigint>,
      ]);
      const minOpen = chainAccount ? this.store.get().minOpen : ((await this.d.chain.readContract(minAccountOpenRead(this.exchange) as never)) as bigint);
      const view = onboardingView({ hasToken: this.record !== undefined, wallet: this.signedRest() ? wallet : undefined, chainAccount, enrollNeedsAccount: this.store.get().enrollNeedsAccount && !chainAccount });
      const r = this.record;
      this.store.update({
        view,
        minOpen,
        walletBalance,
        allowance,
        record: r ? { rotation: r.rotation, publicKeyHex: r.publicKeyHex, enrolledAt: r.enrolledAt } : undefined,
        enrollNeedsAccount: this.store.get().enrollNeedsAccount && !chainAccount,
        refreshedAt: this.d.now(),
      });
      return view;
    } catch (e) {
      this.store.update({ error: describe(e) });
      throw e;
    } finally {
      if (this.store.get().busy === "refresh") this.store.update({ busy: undefined });
    }
  }

  private collateral(): Address {
    return this.d.deployment.collateralToken;
  }

  private async step<T>(name: StepName, run: () => Promise<T>): Promise<T | undefined> {
    if (this.store.get().busy && this.store.get().busy !== "refresh") return undefined;
    this.store.update({ busy: name, error: undefined });
    try {
      return await run();
    } catch (e) {
      this.store.update({ error: describe(e) });
      throw e;
    } finally {
      this.store.update({ busy: undefined });
      await this.refresh().catch(() => undefined);
    }
  }

  private async enrollWith(key: PerplKeyView): Promise<PerplKeyRecord> {
    const account = this.d.auth.account();
    const info = await enrollApiKey({
      apiUrl: this.d.deployment.apiUrl,
      chainId: this.d.chainId,
      address: this.d.address,
      secret: key.signer,
      label: this.d.label ?? "Meridian mobile",
      signTypedData: (def: TypedDataDefinition) => account.signTypedData(def as never),
      fetchFn: this.d.fetchFn,
      // no Origin: measured 9 Oct 2026, /v1/api-key/payload answers 200 without one and 400 with a non-whitelisted one
    });
    const rec: PerplKeyRecord = { token: info.api_key, rotation: key.rotation, publicKeyHex: key.publicKeyHex, chainId: this.d.chainId, address: this.d.address, enrolledAt: this.d.now() };
    await this.d.tokens.write(rec);
    this.record = rec;
    return rec;
  }

  /**
   * ① Enable trading: payload → EIP-712 signature with the passkey account + Ed25519 PoP → enroll → store the token.
   * 409 (this public key is already registered: token lost, or revoked) ⇒ one fresh prompt, next rotations until one
   * is accepted. 404 ⇒ Perpl needs the exchange account first (the screen moves the deposit up).
   */
  async enroll(): Promise<void> {
    await this.step("enroll", async () => {
      const key = this.d.auth.perplKey();
      if (!key) throw new Error("Perpl isn't configured for this build");
      try {
        await this.enrollWith(key);
        this.store.update({ enrollNeedsAccount: false });
      } catch (e) {
        if (e instanceof PerplHttpError && e.status === 404) {
          this.store.update({ enrollNeedsAccount: true });
          throw e;
        }
        if (!(e instanceof PerplHttpError && e.status === 409)) throw e;
        await this.rekey(key.rotation + 1);
      }
    });
  }

  /** "Re-enable trading" (Settings): a new key at rotation + 1 under a fresh prompt (token lost / key revoked). */
  async reenable(): Promise<void> {
    await this.step("enroll", async () => {
      const from = Math.max(this.record?.rotation ?? 0, this.d.auth.perplKey()?.rotation ?? 0) + 1;
      await this.d.tokens.clear(this.d.chainId, this.d.address);
      this.record = undefined;
      await this.rekey(from);
    });
  }

  private async rekey(from: number): Promise<void> {
    if (from > MAX_ROTATION) throw new Error("No free Perpl key slot left");
    await this.d.auth.rekeyPerpl(from, async (k) => {
      try {
        await this.enrollWith(k);
        return true;
      } catch (e) {
        if (e instanceof PerplHttpError && e.status === 409) return false;
        throw e;
      }
    });
  }

  /**
   * ② Deposit: one fresh passkey prompt, then approve EXACTLY `amount` (skipped when the allowance already covers it,
   * e.g. resumed after a kill between the two txs) and createAccount(amount ≥ live minimum) — or depositCollateral when
   * the account already exists (top-up).
   */
  async deposit(input: string): Promise<void> {
    await this.step("deposit", async () => {
      const s = this.store.get();
      const opensAccount = s.view?.account !== "done";
      const decimals = this.d.deployment.collateralDecimals;
      // the minimum is re-read right before createAccount, never trusted from an earlier screen
      const minOpen = opensAccount ? ((await this.d.chain.readContract(minAccountOpenRead(this.exchange) as never)) as bigint) : undefined;
      const walletBalance = (await this.d.chain.readContract({ address: this.collateral(), abi: erc20Abi, functionName: "balanceOf", args: [this.d.address] })) as bigint;
      const c = checkDeposit({ amount: parseAmountUp(input, decimals), walletBalance, minOpen, opensAccount, decimals, symbol: "AUSD" });
      if (!c.ok) throw new UserFacingError(c.error);
      const amount = c.amount;
      await this.d.auth.withFreshSession(async (account) => {
        const allowance = (await this.d.chain.readContract({ address: this.collateral(), abi: erc20Abi, functionName: "allowance", args: [this.d.address, this.exchange] })) as bigint;
        if (needsApprove(allowance, amount)) this.recordTx("approve", await this.d.sendWith(account, approveCollateralTx(this.collateral(), this.exchange, amount)));
        if (opensAccount) this.recordTx("createAccount", await this.d.sendWith(account, createAccountTx(this.exchange, amount, minOpen!)));
        else this.recordTx("deposit", await this.d.sendWith(account, depositCollateralTx(this.exchange, amount)));
      });
    });
  }

  /** ③ Allow fast orders: allowOrderForwarding(true) with the unlocked session (moves no value). */
  async allowForwarding(): Promise<void> {
    await this.step("forwarding", async () => {
      this.recordTx("forwarding", await this.d.sendWith(this.d.auth.account(), allowForwardingTx(this.exchange, true)));
    });
  }

  private recordTx(step: StepName, r: TxResult): void {
    this.store.update({ txs: [...this.store.get().txs, { step, hash: r.hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, gasLimit: r.gasLimit }] });
  }
}

/** An error whose message is already written for the user. */
export class UserFacingError extends Error {
  override name = "UserFacingError";
}

const isRevert = (e: unknown): boolean => {
  const n = (e as { name?: string } | null)?.name ?? "";
  const m = String((e as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (e as Error)?.message ?? "");
  return n === "ContractFunctionExecutionError" || n === "ContractFunctionRevertedError" || /revert/i.test(m);
};

/** Plain words for the screen; Perpl HTTP statuses through explainEnroll / core's table. */
export function describe(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  if (e instanceof PerplHttpError) return e.target.includes("api-key") ? explainEnroll(e.status) : explainHttp(e.status);
  if (e instanceof Error && e.name === "TxError") return e.message;
  if (e instanceof Error && (e.name === "LockedError" || e.name === "PerplKeyWipedError")) return e.message;
  if (e instanceof Error && e.name === "WrongPasskeyError") return e.message;
  return "Something went wrong. Check your connection and try again.";
}
