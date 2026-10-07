import { describe, expect, it, vi } from "vitest";
import { ONBOARD_DEPOSIT, failedStep, firstTradeSizeMon, initialOnboardState, pendingSteps, runOnboarding, type OnboardStep } from "./onboard";

const WAD = 10n ** 18n;
const LOT = 100n * WAD;

describe("pendingSteps (idempotent resume)", () => {
  it("fresh wallet ⇒ mint, approve, deposit", () => {
    expect(pendingSteps({ balance: 0n, allowance: 0n })).toEqual(["mint", "approve", "deposit"]);
  });
  it("skips mint when the balance covers the deposit, approve when the allowance does", () => {
    expect(pendingSteps({ balance: ONBOARD_DEPOSIT, allowance: 0n })).toEqual(["approve", "deposit"]);
    expect(pendingSteps({ balance: ONBOARD_DEPOSIT, allowance: ONBOARD_DEPOSIT })).toEqual(["deposit"]);
    expect(pendingSteps({ balance: ONBOARD_DEPOSIT - 1n, allowance: ONBOARD_DEPOSIT })).toEqual(["mint", "deposit"]);
  });
});

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

function fakeChain() {
  const c = { balance: 0n, allowance: 0n, deposited: 0n };
  const steps: Record<OnboardStep, () => Promise<{ hash: `0x${string}` }>> = {
    mint: vi.fn(async () => ((c.balance += 10_000n * 10n ** 6n), { hash: hash(1) })),
    approve: vi.fn(async () => ((c.allowance = ONBOARD_DEPOSIT), { hash: hash(2) })),
    deposit: vi.fn(async () => ((c.deposited += ONBOARD_DEPOSIT), (c.balance -= ONBOARD_DEPOSIT), (c.allowance -= ONBOARD_DEPOSIT), { hash: hash(3) })),
  };
  return { c, steps, read: async () => ({ balance: c.balance, allowance: c.allowance }) };
}

describe("runOnboarding", () => {
  it("runs mint → approve → deposit and records each hash", async () => {
    const f = fakeChain();
    const updates: string[] = [];
    const s = await runOnboarding({ read: f.read, steps: f.steps, canMint: () => true, onUpdate: (x) => updates.push(`${x.mint.status}${x.approve.status}${x.deposit.status}`) });
    expect(s.mint).toEqual({ status: "done", hash: hash(1) });
    expect(s.approve.hash).toBe(hash(2));
    expect(s.deposit.hash).toBe(hash(3));
    expect(f.c.deposited).toBe(ONBOARD_DEPOSIT);
    expect(updates[0]).toBe("runningtodotodo");
    expect(failedStep(s)).toBeUndefined();
  });

  it("stops at a failed step; retry from there skips what already landed", async () => {
    const f = fakeChain();
    const deposit = f.steps.deposit;
    f.steps.deposit = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    const s1 = await runOnboarding({ read: f.read, steps: f.steps, canMint: () => true, onUpdate: () => {}, describeError: () => "Signature cancelled" });
    expect(failedStep(s1)).toBe("deposit");
    expect(s1.deposit.error).toBe("Signature cancelled");

    f.steps.deposit = deposit;
    const s2 = await runOnboarding({ state: s1, read: f.read, steps: f.steps, canMint: () => true, onUpdate: () => {} });
    expect(f.steps.mint).toHaveBeenCalledTimes(1); // not minted twice
    expect(f.steps.approve).toHaveBeenCalledTimes(1); // allowance already there
    expect(s2.mint.status).toBe("done"); // earlier results kept
    expect(s2.deposit.status).toBe("done");
    expect(failedStep(s2)).toBeUndefined();
  });

  it("a wallet that already holds AUSD skips the faucet (marked skipped)", async () => {
    const f = fakeChain();
    f.c.balance = ONBOARD_DEPOSIT * 2n;
    const s = await runOnboarding({ read: f.read, steps: f.steps, canMint: () => false, onUpdate: () => {} });
    expect(s.mint.status).toBe("skipped");
    expect(f.steps.mint).not.toHaveBeenCalled();
    expect(s.deposit.status).toBe("done");
  });

  it("rate-limited faucet fails the mint step without sending", async () => {
    const f = fakeChain();
    const s = await runOnboarding({ read: f.read, steps: f.steps, canMint: () => false, mintBlocked: "used", onUpdate: () => {} });
    expect(s.mint).toEqual({ status: "failed", error: "used" });
    expect(f.steps.mint).not.toHaveBeenCalled();
    expect(s.approve.status).toBe("todo");
  });

  it("initial state is all todo", () => {
    expect(initialOnboardState()).toEqual({ mint: { status: "todo" }, approve: { status: "todo" }, deposit: { status: "todo" } });
  });
});

describe("firstTradeSizeMon", () => {
  it("≈ $50 notional in whole lots", () => {
    // MON at 0.029: one lot (100 MON) = 2.9 AUSD ⇒ 17 lots = 1,700 MON ≈ 49.3 AUSD
    expect(firstTradeSizeMon(29n * 10n ** 15n, LOT)).toBe("1700");
  });
  it("capped at what the book can fill (testnet MM quotes 5 lots a side); no depth ⇒ no prefill", () => {
    expect(firstTradeSizeMon(29n * 10n ** 15n, LOT, 50n, 5n)).toBe("500");
    expect(firstTradeSizeMon(29n * 10n ** 15n, LOT, 50n, 100n)).toBe("1700");
    expect(firstTradeSizeMon(29n * 10n ** 15n, LOT, 50n, 0n)).toBeUndefined();
  });
  it("at least one lot; no price ⇒ no prefill", () => {
    expect(firstTradeSizeMon(10n * WAD, LOT)).toBe("100");
    expect(firstTradeSizeMon(0n, LOT)).toBeUndefined();
  });
});
