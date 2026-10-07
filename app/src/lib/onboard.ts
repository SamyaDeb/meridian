// One-tap testnet onboarding (K1.4): mint test AUSD → approve → deposit. Pure planning so "Retry from here" is
// idempotent: a step whose effect is already onchain is skipped.

export type OnboardStep = "mint" | "approve" | "deposit";
export const ONBOARD_STEPS: readonly OnboardStep[] = ["mint", "approve", "deposit"];
/** Collateral the flow deposits: 1,000 AUSD (6 dp). */
export const ONBOARD_DEPOSIT = 1_000n * 10n ** 6n;
/** First-trade prefill: ≈ $50 notional. */
export const FIRST_TRADE_NOTIONAL_AUSD = 50n;

export type OnboardChain = {
  /** wallet AUSD balance (6 dp) */
  balance: bigint;
  /** AUSD allowance to the ClearingHouse (6 dp) */
  allowance: bigint;
};

/** Steps still to run: mint only if the wallet can't cover the deposit, approve only if the allowance can't. */
export function pendingSteps(s: OnboardChain, deposit: bigint = ONBOARD_DEPOSIT): OnboardStep[] {
  const out: OnboardStep[] = [];
  if (s.balance < deposit) out.push("mint");
  if (s.allowance < deposit) out.push("approve");
  out.push("deposit");
  return out;
}

export type StepStatus = "todo" | "skipped" | "running" | "done" | "failed";
export type StepState = { status: StepStatus; hash?: `0x${string}`; error?: string };
export type OnboardState = Record<OnboardStep, StepState>;

export const initialOnboardState = (): OnboardState => ({ mint: { status: "todo" }, approve: { status: "todo" }, deposit: { status: "todo" } });

/** The step a retry starts from: the first one that failed (undefined = nothing failed). */
export function failedStep(s: OnboardState): OnboardStep | undefined {
  return ONBOARD_STEPS.find((k) => s[k].status === "failed");
}

/**
 * Size (in MON, whole lots) for the first-trade prefill: the lot count closest to `notionalAusd` at `priceWad`, at least
 * one lot, and never more than `maxLots` (what the book can fill inside the ticket's slippage: a prefill the ticket would
 * refuse is worse than a smaller one). `maxLots` = 0 ⇒ no prefill. Returned as the ticket's MON input string.
 */
export function firstTradeSizeMon(priceWad: bigint, lotSizeWad: bigint, notionalAusd: bigint = FIRST_TRADE_NOTIONAL_AUSD, maxLots?: bigint): string | undefined {
  if (priceWad <= 0n || lotSizeWad <= 0n || maxLots === 0n) return undefined;
  const WAD = 10n ** 18n;
  const lotNotionalWad = (lotSizeWad * priceWad) / WAD; // display only, rounds down
  if (lotNotionalWad === 0n) return undefined;
  const target = notionalAusd * WAD;
  let lots = (target + lotNotionalWad / 2n) / lotNotionalWad; // nearest
  if (lots < 1n) lots = 1n;
  if (maxLots !== undefined && lots > maxLots) lots = maxLots;
  return ((lots * lotSizeWad) / WAD).toString();
}

export type StepResult = { hash: `0x${string}` };

/**
 * Runs the pending steps in order, re-reading the chain first so a retry skips what already landed. `onUpdate`
 * gets every state change (the sheet renders it). Stops at the first failure; returns the final state.
 * `canMint` = the faucet's UI rate limit allows a claim now (else the mint step fails with `mintBlocked`).
 */
export async function runOnboarding(o: {
  read: () => Promise<OnboardChain>;
  steps: Record<OnboardStep, () => Promise<StepResult>>;
  state?: OnboardState;
  deposit?: bigint;
  canMint: () => boolean;
  mintBlocked?: string;
  onUpdate: (s: OnboardState) => void;
  describeError?: (e: unknown) => string;
}): Promise<OnboardState> {
  let state: OnboardState = { ...(o.state ?? initialOnboardState()) };
  const set = (k: OnboardStep, v: StepState) => {
    state = { ...state, [k]: v };
    o.onUpdate(state);
  };
  const todo = pendingSteps(await o.read(), o.deposit ?? ONBOARD_DEPOSIT);
  for (const k of ONBOARD_STEPS) if (!todo.includes(k) && state[k].status !== "done") set(k, { status: "skipped" });
  for (const k of todo) {
    if (k === "mint" && !o.canMint()) {
      set(k, { status: "failed", error: o.mintBlocked ?? "Faucet already used in the last hour" });
      return state;
    }
    set(k, { status: "running" });
    try {
      const r = await o.steps[k]();
      set(k, { status: "done", hash: r.hash });
    } catch (e) {
      set(k, { status: "failed", error: o.describeError ? o.describeError(e) : e instanceof Error ? e.message : String(e) });
      return state;
    }
  }
  return state;
}
