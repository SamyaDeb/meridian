"use client";
// One-tap testnet onboarding (K1.4): "Get 10,000 test AUSD & deposit 1,000" runs mint → approve → deposit (sponsored
// for Privy embedded wallets) with one progress sheet. Testnet / anvil only (lib/faucet.ts); never rendered on 143.
import { useState } from "react";
import { useAccount } from "wagmi";
import type { PublicClient } from "viem";
import { Button, Dialog } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress, deploymentFor } from "@/config/deployments";
import { erc20Abi } from "@/lib/abi";
import { FAUCET_AMOUNT, faucetAvailable, msUntilNextClaim, readLastClaim, writeLastClaim } from "@/lib/faucet";
import { describeSignError } from "@/lib/login";
import { ONBOARD_DEPOSIT, ONBOARD_STEPS, failedStep, initialOnboardState, runOnboarding, type OnboardState, type OnboardStep } from "@/lib/onboard";
import { approveToken, depositCollateral, mintTestAusd } from "@/lib/tx";
import { formatAusdToken } from "@/lib/format";
import { READ_CHAIN_ID, readChain } from "@/lib/wagmi";

const LABEL: Record<OnboardStep, string> = {
  mint: `Get ${formatAusdToken(FAUCET_AMOUNT).replace(/\.00$/, "")} test AUSD (no value)`,
  approve: "Allow the exchange to use your AUSD",
  deposit: `Deposit ${formatAusdToken(ONBOARD_DEPOSIT).replace(/\.00$/, "")} AUSD as collateral`,
};
export const ONBOARD_CTA = `Get ${formatAusdToken(FAUCET_AMOUNT).replace(/\.00$/, "")} test AUSD & deposit ${formatAusdToken(ONBOARD_DEPOSIT).replace(/\.00$/, "")}`;

/** Testnet faucet + deposit is offered on this build's chain (AUSD is our MockERC20 there). */
export const onboardingOffered = (): boolean => faucetAvailable(READ_CHAIN_ID, deploymentFor(READ_CHAIN_ID));

export function useOnboarding({ onDone }: { onDone?: () => void } = {}) {
  const tx = useTx();
  const { address } = useAccount();
  const ausd = contractAddress(READ_CHAIN_ID, "AUSD");
  const ch = contractAddress(READ_CHAIN_ID, "ClearingHouse");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OnboardState>(initialOnboardState);
  const [result, setResult] = useState<"ok" | "failed" | null>(null);
  const available = onboardingOffered() && Boolean(ausd && ch);

  const start = (resume: boolean) => {
    if (!ausd || !ch || !address) return;
    setOpen(true);
    setResult(null);
    const from = resume ? state : initialOnboardState();
    if (!resume) setState(from);
    void tx.run("Onboarding", async (p: PublicClient, w) => {
      const me = w.account!.address;
      let last: { block: bigint; gasUsed: bigint; gasLimit: bigint } = { block: 0n, gasUsed: 0n, gasLimit: 0n };
      const keep = <T extends { hash: `0x${string}`; block: bigint; gasUsed: bigint; gasLimit: bigint }>(r: T) => ((last = r), r);
      const final = await runOnboarding({
        state: from,
        read: async () => ({
          balance: await p.readContract({ address: ausd, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
          allowance: await p.readContract({ address: ausd, abi: erc20Abi, functionName: "allowance", args: [me, ch] }),
        }),
        canMint: () => msUntilNextClaim(readLastClaim(READ_CHAIN_ID, me), Date.now()) === 0,
        mintBlocked: "Faucet already used from this browser in the last hour",
        steps: {
          mint: async () => {
            const r = keep(await mintTestAusd(p, w, ausd, FAUCET_AMOUNT));
            writeLastClaim(READ_CHAIN_ID, me, Date.now());
            return r;
          },
          approve: async () => keep(await approveToken(p, w, ausd, ch, ONBOARD_DEPOSIT)),
          deposit: async () => keep(await depositCollateral(p, w, ch, ONBOARD_DEPOSIT)),
        },
        onUpdate: setState,
        describeError: describeSignError,
      });
      const failed = failedStep(final);
      if (failed) {
        setResult("failed");
        throw new Error(`${LABEL[failed]}: ${final[failed].error ?? "failed"}`);
      }
      setResult("ok");
      // close the sheet after a beat (no extra tap); the ticket takes over with a prefilled size
      setTimeout(() => {
        setOpen(false);
        onDone?.();
      }, 1_200);
      return last;
    });
  };

  return { available, open, close: () => setOpen(false), state, result, busy: tx.busy, sponsored: tx.sponsored, start: () => start(false), retry: () => start(true) };
}

const ICON: Record<OnboardState[OnboardStep]["status"], string> = { todo: "○", skipped: "–", running: "…", done: "✓", failed: "!" };

export function OnboardSheet({ o }: { o: ReturnType<typeof useOnboarding> }) {
  const explorer = readChain().chain.blockExplorers?.default.url;
  const failed = failedStep(o.state);
  return (
    <Dialog
      open={o.open}
      onClose={o.close}
      title="Setting up your account"
      footer={
        failed && !o.busy ? (
          <Button variant="brand" block size="lg" onClick={o.retry}>
            Retry from here
          </Button>
        ) : undefined
      }
    >
      <p className="text-xs text-muted">
        {o.sponsored ? "Gas is on us: you don't need MON." : "Each step is a transaction from your wallet."} Test AUSD has no value.
      </p>
      <ol className="mt-3 space-y-2" data-testid="onboard-steps">
        {ONBOARD_STEPS.map((k, i) => {
          const s = o.state[k];
          return (
            <li key={k} data-step={k} data-status={s.status} className="flex items-start gap-3 rounded-inner bg-card-2 px-3 py-2 text-sm">
              <span aria-hidden className={`num mt-0.5 h-5 w-5 shrink-0 rounded-full text-center text-[11px] leading-5 ${s.status === "done" ? "bg-long text-on-brand" : s.status === "failed" ? "bg-short text-on-brand" : "bg-surface-2"}`}>
                {s.status === "todo" ? i + 1 : ICON[s.status]}
              </span>
              <span className="min-w-0 flex-1">
                <span className={s.status === "skipped" ? "text-muted line-through" : ""}>{LABEL[k]}</span>
                <span className="sr-only">: {s.status}</span>
                {s.status === "skipped" && <span className="block text-[11px] text-muted">Already done</span>}
                {s.status === "running" && <span className="block text-[11px] text-muted">Confirming…</span>}
                {s.status === "failed" && (
                  <span role="alert" className="block break-words text-[11px] text-short">
                    {s.error}
                  </span>
                )}
                {s.hash && explorer && (
                  <a href={`${explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer" className="num block text-[11px] text-accent underline">
                    View transaction ↗
                  </a>
                )}
                {s.hash && !explorer && <span className="num block break-all text-[11px] text-muted">{s.hash}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {o.result === "ok" && (
        <p role="status" className="mt-3 text-sm text-long">
          You&apos;re funded. Pick long or short and place your first trade.
        </p>
      )}
    </Dialog>
  );
}
