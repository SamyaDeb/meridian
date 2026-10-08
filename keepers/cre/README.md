# keepers/cre: Chainlink CRE backstop keeper

Three Chainlink CRE workflows that remove the perp's single point of failure, the TS keeper (`keepers/ts-fallback`). Each one turns onchain reads into a signed report, `abi.encode(uint8 action, bytes payload)`, delivered through a Chainlink forwarder to `MeridianKeeperReceiver` (`contracts/src/automation/`, frozen interface `IMeridianKeeperReceiver`, CR-016 / interfaces-v1.8, PHASES decision 43). The TS keeper stays the primary keeper. CRE is the backstop.

**What has run, and how (be exact about this):** every transaction listed in `docs/outputs/PROOF.md` §13 came from `cre workflow simulate --broadcast`. That is the CRE runtime with the real workflow WASM, run by **one machine** (ours), with reports delivered through Chainlink's **simulation forwarder** `MockKeystoneForwarder` on Monad testnet. **No DON has executed these workflows.** DON deployment needs CRE Early Access: `cre account access` printed "Deployment access is not yet enabled for your organization" on 8 Oct 2026. It was not granted by submission.

## Workflows

| Workflow | Trigger | Reads (≤ 15 per run, CRE quota) | Report → receiver action |
|---|---|---|---|
| **W1 `liquidation-guardian/`** | EVM log `PriceUpdated` on each market's oracle (a price move is when accounts cross maintenance), plus a cron fallback every 30 s | head; `PositionChanged` logs of the last ≤ 100 blocks (CRE log-query limit); optional Envio indexer query under DON consensus; configured `watchAccounts`; `getAccount` to **confirm** each candidate is liquidatable; the receiver's own position | `2 LIQUIDATE(ch, accounts ≤ 32)`: the receiver liquidates, sized onchain to its own headroom. Then `5 UNWIND(ch, max)`: the receiver closes what it inherited with a reduce-only IOC at index ± 1% |
| **W2 `upkeep/`** | cron 60 s | head; each CH `fundingState().lastUpdateBlock`; vault `needsRebalance()`; then `rebalance()` dry-run as the receiver | `3 FUNDING_POKE(chs)` for markets ≥ `maxGapBlocks` (40) behind (the TS keeper keeps the gap ≤ 20, so W2 only writes when it has fallen behind). `1 VAULT_REBALANCE(vault)` only if the dry-run doesn't revert |
| **W3 `mfi-publisher/`** | cron 5 min | Meridian `averageFundingApr(12,000)` (with shorter fallback windows), `openInterest`, `markPrice`; Perpl's MON market over HTTP on every node, aggregated by DON consensus (identical rate / event / interval, median OI); the feed's last block | `6 MFI_PUBLISH(feed, mfi, meridianApr, perplApr, block, perplFundingBlock)` → `MeridianMfiFeed.latest()`, readable by any contract |

Pure logic lives in `shared/` (`liquidation.ts`, `upkeep.ts`, `mfi.ts`, `report.ts`, `abi.ts`) and is unit-tested (`pnpm test`, vitest). `shared/cre.ts` is the SDK glue (read budget, gas, delivery). It needs the WASM runtime, so `cre workflow simulate` exercises it (`evidence/`).

**Gas:** limit = (`estimateGas` of `onReport` from the forwarder + `forwarderOverheadGas`) × 1.2, capped at `maxGas`. Monad bills the limit. `forwarderOverheadGas` stays at 150,000. On 8 Oct one W3 report at 30,000 reverted at a 110,871 limit (`0xfa39f7ff672a22a07181eed269b1ae9ef6e8891de38d9599d612535d8cea3e74`, `evidence/w3-mfi-broadcast-4.log`). A local `cast run` replay of the same tx succeeds with 99,189 gas, but that replay is Ethereum-priced. Monad's cold-access pricing is higher, so replays understate Monad gas and can't be used to tighten this. > VERIFY: the production `KeystoneForwarder`'s overhead on Monad (it also verifies DON signatures) before lowering the margin.

**Why W2 dry-runs `rebalance()`:** the receiver isolates a failing item (`ReportExecuted.success = false`, no revert), so the `onReport` estimate never fails. Without the dry-run, a vault that can't rebalance would cost a report every minute. That happened on 10143 on 8 Oct (`SlippageExceeded`, `0x65714e8197c934e64ca859aa85e33d186cd285bc688e9a924d0fdb11cdbe9172`, ≈ 0.055 MON).

**W3 vs the MFI service (`mfi/`, docs/MFI.md):** same formula, rounds toward zero (MFI §4.4), same Meridian read. One difference: the service weights each venue by its **1-hour minimum OI** (MFI §4.1). The workflow is stateless across runs, so it uses the **current** OI (Perpl's floored to whole AUSD, median across nodes). With equal inputs the two agree exactly. On 8 Oct both values recomputed bit-for-bit from their own inputs, and the gap was 1.3e-8 relative with Perpl OI flat, 4.5e-6 with OI moving (PROOF §13).

## Run it

```bash
cd keepers/cre
pnpm install && pnpm test && pnpm typecheck
cre login                                                   # once per machine
# .env (git-ignored, see .env.example): CRE_ETH_PRIVATE_KEY (a key used only for CRE broadcasts, never a bot key), MONAD_TESTNET_RPC_URL
cre workflow simulate upkeep        --target staging-settings --trigger-index 0 --non-interactive               # dry run (tx hashes 0x000…)
cre workflow simulate upkeep        --target staging-settings --trigger-index 0 --non-interactive --broadcast   # sends
cre workflow simulate mfi-publisher --target staging-settings --trigger-index 0 --non-interactive --broadcast
# W1: trigger 0 = oracle log, 1 = cron. --listen runs the workflow for every matching log (log triggers only)
cre workflow simulate liquidation-guardian --target staging-settings --trigger-index 0 --listen --broadcast --non-interactive
cre workflow simulate liquidation-guardian --target staging-settings --trigger-index 1 --broadcast --non-interactive
# a single past log: --trigger-index 0 --evm-tx-hash 0x… --evm-event-index <n>
```
- `--config` overrides `config.staging.json`. Give it an **absolute** path (a relative one failed "must be a valid existing file" with CLI v1.37.0). The 8 Oct W1 runs used `liquidation-guardian/config.w1-demo.json` = staging + the labelled test wallet in `watchAccounts`: its position was opened more than 100 blocks before the crash, and the Envio indexer still serves the old markets.
- Verify every run onchain, not from the CLI output: `cast receipt <hash>`, the receiver's `ReportExecuted(action, success, workflowId)` (in simulation `workflowId` = `0x1111…1111`), and the downstream event (`FundingUpdated`, `Liquidated` with the receiver as liquidator, `Unwound`, `MfiPublished`).
- Versions: CRE CLI v1.37.0, `@chainlink/cre-sdk` 1.23.0. WASM gotchas: no `Buffer`; don't export functions that take parameters (javy).

## Config and secrets

`*/config.staging.json` holds addresses and parameters only (from `deployments/10143.json`). Target `staging-settings` = Monad testnet (`project.yaml`, chain name `monad-testnet`). No CRE secrets are used (`secrets-path: ""`). The Perpl API and the Envio endpoint are public. The broadcaster key and RPC URL come from `.env` and are never committed (`git check-ignore keepers/cre/.env`).

## Identity checks and moving to the production forwarder

Every `onReport` checks `msg.sender == forwarder()`. CR-016 adds workflow identity: `setExpectedWorkflow(workflowOwner, workflowId)` makes the receiver require both in the report metadata (`workflowId (32) ‖ workflowName (10) ‖ workflowOwner (20) ‖ reportId (2)`). Zero = check off. The simulation forwarder carries no real owner or ID, so on 10143 both are zero (`expectedWorkflowOwner()`, `expectedWorkflowId()` read `0x0`).

When Early Access is granted:
1. `cre workflow deploy` W2, then W3, then W1 (`cre workflow list` / `get` to check them). Note each workflow ID and the owner address.
2. Owner tx: `MeridianKeeperReceiver.setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)`. That is the monad-testnet `KeystoneForwarder` (`cre workflow supported-chains`, matching the `IMeridianKeeperReceiver` NatSpec). Mainnet: `0x76c9cf548b4179F8901cda1f8623568b58215E62`.
3. Owner tx: `setExpectedWorkflow(<workflow owner>, bytes32(0))`. The receiver stores one expected workflow ID and three workflows report to it, so check the **owner only** (each field is checked only when non-zero, `_checkIdentity`). Pinning every workflow ID would need one receiver per workflow (owner decision; the interface is frozen).
4. Set `forwarder` in each `config.*.json` to the production address (it is the `from` of the gas estimate). Then confirm one DON-originated `ReportExecuted` with a non-mock `workflowId`.
