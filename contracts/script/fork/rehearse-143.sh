#!/usr/bin/env bash
# Mainnet-FORK rehearsal of DeployMeridian with the real config/143.json (Phase 3 P2).
#
#   anvil --fork-url $MONAD_RPC_URL --fork-block-number <N> --host 127.0.0.1 --port 8545 --code-size-limit 131072 &
#   bash script/fork/rehearse-143.sh            # from contracts/
#
# Broadcasts ONLY to a local anvil: the RPC must be localhost AND answer anvil_nodeInfo (a real Monad node rejects
# anvil_* methods), and its chain id must be 143 (the fork keeps the mainnet id so every 143 code path runs).
# Owner = FORK STAND-IN — not the real Safe (anvil dev account #9 unless FORK_OWNER is set), patched into 143.json
# for the run only and restored on exit (also on failure). Keys are anvil's public dev keys; never a real key.
# Output: ../deployments/dry-run/143-fork.json (labelled), ../runs/mainnet-fork/<date>/ (logs, broadcast record).
set -euo pipefail

RPC="${FORK_RPC_URL:-http://127.0.0.1:8545}"
case "$RPC" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing: FORK_RPC_URL must be localhost, got a non-local URL" >&2; exit 1 ;;
esac
cast rpc anvil_nodeInfo --rpc-url "$RPC" >/dev/null 2>&1 || { echo "refusing: $RPC is not an anvil node" >&2; exit 1; }
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$CHAIN_ID" = "143" ] || { echo "refusing: fork chain id is $CHAIN_ID, expected 143 (anvil --fork-url mainnet)" >&2; exit 1; }

cd "$(dirname "$0")/../.."   # contracts/
ROOT="$(cd .. && pwd)"
# anvil dev keys #0 (deployer), #1 (keeper), #2 (MM); #9 = owner stand-in. Public test keys, fork only.
DEPLOYER_PK_ANVIL=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
MM=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
OWNER="${FORK_OWNER:-0xa0Ee7A142d267C1f36714E4a8F75612F20a79720}"
# forge simulates all deploy txs in ONE EVM session (slots touched earlier stay warm), so its estimates are low for
# the later one-shot setters: at 120 `CH.setOrderBook` ran out of gas on the fork (limit 51,228, rehearsal 5 Oct).
GAS_MULT="${GAS_MULT:-200}"

FORK_BLOCK="$(cast rpc anvil_nodeInfo --rpc-url "$RPC" | jq -r '.forkConfig.forkBlockNumber // empty')"
[ -n "$FORK_BLOCK" ] || FORK_BLOCK="$(cast block-number --rpc-url "$RPC")"
DATE="$(date -u +%Y-%m-%d)"
OUT_DIR="$ROOT/runs/mainnet-fork/$DATE"
mkdir -p "$OUT_DIR" "$ROOT/deployments/dry-run"

CFG=script/config/143.json
BAK="$(mktemp)"
cp "$CFG" "$BAK"
restore() {
  cp "$BAK" "$CFG"
  rm -f "$BAK"
  # forge's records for chain 143 would look like a mainnet run: move the broadcast record into the run folder and
  # drop the cache entry (forge's "sensitive values" file; here only anvil dev data), on success and on failure.
  if [ -f broadcast/DeployMeridian.s.sol/143/run-latest.json ]; then
    mv broadcast/DeployMeridian.s.sol/143/run-latest.json "$OUT_DIR/deploy.broadcast.json"
  fi
  rm -rf broadcast/DeployMeridian.s.sol/143 cache/DeployMeridian.s.sol/143
}
trap restore EXIT
jq --arg o "$OWNER" '.owner = $o' "$BAK" > "$CFG"

echo "mainnet fork @ block $FORK_BLOCK, chain id $CHAIN_ID, owner $OWNER (FORK STAND-IN — not the real Safe)"
DEPLOYER_PK=$DEPLOYER_PK_ANVIL KEEPER_ADDRESS=$KEEPER MM_ADDRESS=$MM DEPLOY_VAULT=1 DEPLOY_SWAPS=1 \
  SWAP_MATURITY_IN_SEC=0 REUSE_DEPLOYMENT= DEPLOY_CRE_RECEIVER=false DEPLOY_CONFIG= \
  DEPLOYMENTS_OUT=dry-run/143-fork.json \
  forge script script/DeployMeridian.s.sol --rpc-url "$RPC" --broadcast --slow \
  --code-size-limit 131072 --gas-estimate-multiplier "$GAS_MULT" 2>&1 | tee "$OUT_DIR/deploy.log"

DEP="$ROOT/deployments/dry-run/143-fork.json"
for a in $(jq -r '.contracts[]' "$DEP"); do
  [ "$(cast code "$a" --rpc-url "$RPC")" != "0x" ] || { echo "no code at $a after the broadcast" >&2; exit 1; }
done
jq --arg b "$FORK_BLOCK" --arg o "$OWNER" '
  {"_label": ("MAINNET FORK REHEARSAL @ block " + $b + " (anvil, chain id 143): NOT a mainnet deployment"),
   "_owner": "FORK STAND-IN — not the real Safe (anvil dev account #9); need Safe address (HUMAN_CHECKLIST #3)",
   "forkBlock": ($b | tonumber), "fork": true} + .' "$DEP" > "$DEP.tmp" && mv "$DEP.tmp" "$DEP"
echo "wrote $DEP and $OUT_DIR"
