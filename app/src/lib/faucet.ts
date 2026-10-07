// Test AUSD faucet (K1.3). Testnet / anvil only: the AUSD there is our MockERC20, whose mint(to, amount) is open.
// Never on 143: mainnet AUSD is the real token and has no open mint.

/** 10,000 AUSD in token units (6 dp, CONTRIBUTING.md §2). */
export const FAUCET_AMOUNT = 10_000n * 10n ** 6n;
export const FAUCET_COOLDOWN_MS = 60 * 60 * 1000;
export const FAUCET_STORAGE_PREFIX = "meridian.faucet.";
const MAINNET_CHAIN_ID = 143;

/** Shown only when the chain's deployment record lists AUSD under mockContracts, and never on mainnet. */
export function faucetAvailable(chainId: number, deployment: { mockContracts?: readonly string[] } | undefined): boolean {
  if (chainId === MAINNET_CHAIN_ID) return false;
  return deployment?.mockContracts?.includes("AUSD") ?? false;
}

/** UI rate limit: one claim per address per hour. Returns ms until the next claim (0 = allowed). */
export function msUntilNextClaim(lastClaimMs: number | undefined, nowMs: number): number {
  if (lastClaimMs === undefined || !Number.isFinite(lastClaimMs)) return 0;
  return Math.max(0, lastClaimMs + FAUCET_COOLDOWN_MS - nowMs);
}

const key = (chainId: number, address: string) => `${FAUCET_STORAGE_PREFIX}${chainId}.${address.toLowerCase()}`;

/** localStorage can throw (private mode, blocked storage): then there is no UI limit beyond "disabled while pending". */
export function readLastClaim(chainId: number, address: string): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key(chainId, address));
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastClaim(chainId: number, address: string, nowMs: number): void {
  try {
    globalThis.localStorage?.setItem(key(chainId, address), String(nowMs));
  } catch {
    // storage unavailable: no cross-reload limit
  }
}
