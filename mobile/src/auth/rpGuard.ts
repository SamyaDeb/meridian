// The passkey rpId is permanent (MOBILE_PLAN §0.4 rule 9): a passkey made on the wrong host strands the user. Refuse
// passkey creation unless the configured rpId is the known one for this build's APP_ENV (MOBILE_PLAN §5, N0 ids).
import type { AppEnv } from "../config/appConfig";

export const KNOWN_RP_IDS: Record<AppEnv, string> = {
  development: "meridian-testnet.vercel.app",
  staging: "meridian-testnet.vercel.app",
  production: "meridianfi.vercel.app",
};

/** undefined = OK; otherwise a plain-language reason the app must not create or use passkeys. */
export function rpIdProblem(cfg: { env: AppEnv; rpId: string }): string | undefined {
  const want = KNOWN_RP_IDS[cfg.env];
  if (cfg.rpId !== want) return `This build is set up for the wrong passkey domain (${cfg.rpId}). Install the official Meridian app.`;
  return undefined;
}
