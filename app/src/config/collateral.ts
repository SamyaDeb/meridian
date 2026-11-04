// The collateral symbol shown everywhere in the app: the one the app's chain record carries (deployments/<id>.json).
// USDC since the 4 Nov 2026 redeploy; a record deployed before it still says AUSD, so its tAUSD is never shown as USDC.
// The chain id is derived like lib/wagmi.ts READ_CHAIN_ID, without importing wagmi (server pages and metadata use this).
import { collateralOf, deploymentFor } from "./deployments";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.NEXT_PUBLIC_LOCAL_CHAIN_ID ?? "31337");

export const COLLATERAL = collateralOf(deploymentFor(chainId)).symbol;
