// Mera passkey wallet on the web (LAUNCH_PLAN §6 W1). Same rpId as the native app, so one passkey gives the same
// address on the phone and on the laptop. The rpId is permanent (MOBILE_PLAN §0.4 rule 9): a passkey made under the
// wrong host strands its wallet (recovery = the exported phrase), so creation is refused unless the host is right.
// Known hosts: MOBILE_PLAN §5 (N0 ids, 8 Oct): production meridianfi.vercel.app, staging meridian-testnet.vercel.app.

/** NEXT_PUBLIC_MERA_RP_ID: unset ⇒ no passkey wallet in this build. */
export const MERA_RP_ID: string | undefined = process.env.NEXT_PUBLIC_MERA_RP_ID || undefined;
export const meraEnabled = MERA_RP_ID !== undefined;

export const PRODUCTION_RP_ID = "meridianfi.vercel.app";
export const STAGING_RP_ID = "meridian-testnet.vercel.app";
/** Local dev only: a localhost passkey is throwaway (it never matches the phone's). */
export const LOCAL_RP_ID = "localhost";
const MAINNET_CHAIN_ID = 143;

/**
 * undefined = passkeys may be created and used here; otherwise a plain reason they may not. Pure.
 * Rules: the rpId is one of ours, it is this page's host (WebAuthn would refuse a mismatch with an opaque error), and
 * mainnet (143) only ever uses the production rpId.
 */
export function rpIdProblem(rpId: string | undefined, hostname: string, chainId: number): string | undefined {
  if (!rpId) return "Passkey wallets aren't set up in this build.";
  if (![PRODUCTION_RP_ID, STAGING_RP_ID, LOCAL_RP_ID].includes(rpId)) return `Unknown passkey domain ${rpId}.`;
  if (rpId !== hostname) return `Passkey wallets work on ${rpId} only.`;
  if (chainId === MAINNET_CHAIN_ID && rpId !== PRODUCTION_RP_ID) return `Mainnet passkey wallets live on ${PRODUCTION_RP_ID} only.`;
  return undefined;
}
