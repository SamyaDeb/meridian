// The tab's one passkey wallet (browser only). undefined when this build has no rpId, on the server, or when the
// rpId doesn't fit this host / chain (lib/mera/config.ts): then no passkey button is shown and nothing is created.
import { READ_CHAIN_ID } from "@/lib/wagmi";
import { MERA_RP_ID, rpIdProblem } from "./config";
import type { KV } from "./record";
import { PasskeyWallet } from "./wallet";

let wallet: PasskeyWallet | undefined;

function localStorageOrUndefined(): KV | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined; // blocked site data: the wallet still works, it just doesn't remember the passkey
  }
}

export function getPasskeyWallet(): PasskeyWallet | undefined {
  if (typeof window === "undefined" || !MERA_RP_ID) return undefined;
  if (rpIdProblem(MERA_RP_ID, window.location.hostname, READ_CHAIN_ID)) return undefined;
  wallet ??= new PasskeyWallet({
    rpId: MERA_RP_ID,
    kv: localStorageOrUndefined(),
    yieldToPaint: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  });
  return wallet;
}

/** Why there is no passkey wallet here (for a dev console line), or undefined when there is one / none configured. */
export function passkeyUnavailableReason(): string | undefined {
  if (typeof window === "undefined" || !MERA_RP_ID) return undefined;
  return rpIdProblem(MERA_RP_ID, window.location.hostname, READ_CHAIN_ID);
}
