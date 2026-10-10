// K6 B4: which production settings this deployment has, as booleans only (never a value: RPC URLs carry keys). The
// owner opens /api/health on the production URL to check the Vercel env before testers arrive (docs/outputs/TESTNET_GUIDE.md).
type Env = Record<string, string | undefined>;

const set = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Settings a tester-ready build needs, with whether each is set. `ready` = every required one is. */
export function healthReport(env: Env) {
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID ?? "31337");
  const required = {
    // chain mode on testnet, Privy login, indexer-backed history/stats, testnet RPC for reads
    chainData: env.NEXT_PUBLIC_DATA_SOURCE === "chain",
    testnetChain: chainId === 10143,
    privyAppId: set(env.NEXT_PUBLIC_PRIVY_APP_ID),
    indexerUrl: set(env.NEXT_PUBLIC_INDEXER_URL),
    testnetRpcPublic: set(env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL),
  };
  const optional = {
    mfiUrl: set(env.NEXT_PUBLIC_MFI_URL),
    // server-only (Rates & Risk Perpl routes, PR #3): never NEXT_PUBLIC
    testnetRpcServer: set(env.MONAD_TESTNET_RPC_URL),
    mainnetRpcServer: set(env.MONAD_RPC_URL),
    perplReference: set(env.NEXT_PUBLIC_PERPL_REFERENCE),
    alertsChannelUrl: set(env.NEXT_PUBLIC_ALERTS_CHANNEL_URL),
    siteUrl: set(env.NEXT_PUBLIC_SITE_URL),
    // gas sponsorship is on unless explicitly "0"
    sponsorGas: env.NEXT_PUBLIC_SPONSOR_GAS !== "0",
  };
  // a dev-only setting in production would let anyone act as one fixed account
  const unsafe = { devAccountSet: set(env.NEXT_PUBLIC_DEV_ACCOUNT), deploymentOverride: set(env.NEXT_PUBLIC_DEPLOYMENT_OVERRIDE) };
  const ready = Object.values(required).every(Boolean) && !unsafe.devAccountSet;
  return { ready, chainId, required, optional, unsafe, commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null };
}
