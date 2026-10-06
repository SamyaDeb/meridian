// Railway Infrastructure as Code for the MFI service (decision D15; runbook docs/outputs/MFI_HOSTING.md).
// Plan / apply from mfi/ after `railway login` + `railway link` (owner's account):
//   railway config plan     # read-only preview
//   railway config apply    # creates the service + volume after confirmation
// Secrets are never written here: RPC URLs are `preserve()` (set them once in the Railway dashboard).
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

/** This file manages only the MFI service; other Meridian resources may live in other partials. */
export const partial = "mfi";

export default defineRailway(() => {
  // MFI history (append-only JSONL, decision D7) must survive redeploys: one small volume at /data.
  const data = volume("mfi-data");

  const mfi = service("meridian-mfi", {
    // repo root, not mfi/: the service reads deployments/<chainId>.json and the pnpm workspace lockfile
    source: github("SamyaDeb/Meridian", { branch: "main" }),
    build: 'pnpm install --frozen-lockfile --filter "@meridian/mfi..."',
    start: "pnpm --filter @meridian/mfi start",
    healthcheck: "/healthz",
    volumeMounts: { "/data": data },
    env: {
      MFI_CHAIN_ID: "10143", // switch to "143" once deployments/143.json exists (mainnet day)
      MFI_HISTORY_PATH: "/data/history.jsonl",
      MONAD_TESTNET_RPC_URL: preserve(), // secret: set in the dashboard
      MONAD_RPC_URL: preserve(), // secret: set in the dashboard (needed when MFI_CHAIN_ID=143)
    },
  });

  return project("meridian", { resources: [data, mfi] });
});
