// MON + AUSD balances of one address, re-read on every new block (one read in flight at a time). Token addresses come
// from the deployment readers and decimals from the token itself (never typed in).
import { erc20Abi, type Address, type PublicClient } from "viem";
import type { AppConfig } from "../config/appConfig";
import { Store } from "../live/store";

export type TokenSpec = { key: string; label: string; address: Address };
export type TokenBalance = { label: string; amount: bigint | undefined; decimals: number | undefined };
export type BalanceState = { mon: bigint | undefined; tokens: TokenBalance[]; block: bigint | undefined; error: string | undefined };

/** Meridian's AUSD; Perpl's collateral too when it is a different token (testnet: two mocks). */
export function balanceTokens(cfg: Pick<AppConfig, "meridian" | "perpl">): TokenSpec[] {
  const out: TokenSpec[] = [];
  if (cfg.meridian.status === "deployed") {
    const d = cfg.meridian.deployment;
    out.push({ key: "ausd", label: d.mockContracts.includes("AUSD") ? "Test AUSD (Meridian)" : "AUSD", address: d.contracts.AUSD });
  }
  if (cfg.perpl.status === "deployed") {
    const c = cfg.perpl.deployment.collateralToken;
    if (!out.some((t) => t.address.toLowerCase() === c.toLowerCase())) out.push({ key: "perpl", label: "Test AUSD (Perpl)", address: c });
  }
  return out;
}

export class BalanceReader {
  readonly store: Store<BalanceState>;
  private inFlight = false;
  private decimals: (number | undefined)[];

  constructor(
    private d: { client: PublicClient; address: Address; tokens: TokenSpec[] },
  ) {
    this.decimals = d.tokens.map(() => undefined);
    this.store = new Store<BalanceState>({ mon: undefined, tokens: d.tokens.map((t) => ({ label: t.label, amount: undefined, decimals: undefined })), block: undefined, error: undefined });
  }

  async onBlock(block: bigint): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const { client, address, tokens } = this.d;
    try {
      await Promise.all(
        tokens.map(async (t, i) => {
          if (this.decimals[i] === undefined) this.decimals[i] = await client.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" });
        }),
      );
      const [mon, ...amounts] = await Promise.all([
        client.getBalance({ address }),
        ...tokens.map((t) => client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })),
      ]);
      this.store.set({ mon, tokens: tokens.map((t, i) => ({ label: t.label, amount: amounts[i], decimals: this.decimals[i] })), block, error: undefined });
    } catch {
      // keep the last values; the UI shows them dimmed with the error line
      this.store.update({ error: "Couldn't read balances on this block" });
    } finally {
      this.inFlight = false;
    }
  }
}

/** token units → WAD (exact for decimals ≤ 18), for the shared formatter */
export const toWad = (amount: bigint, decimals: number): bigint => (decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18));
