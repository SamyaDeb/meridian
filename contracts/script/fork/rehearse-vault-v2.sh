#!/usr/bin/env bash
# Vault v2 (CR-014) deploy rehearsal on a LOCAL anvil fork: DeployVaultV2 against a perp record, then
# VerifyDeployment (HARDENING_PLAN P5.3i; P6 runs the same DeployVaultV2 for real on 10143).
#
#   anvil --fork-url <10143 or 143 rpc> --host 127.0.0.1 --port 8545 --code-size-limit 131072 &
#   bash script/fork/rehearse-vault-v2.sh        # from contracts/
#
# Broadcasts ONLY to a local anvil (localhost + anvil_nodeInfo, like rehearse-143.sh). Keys: anvil's public dev keys;
# the owner/keeper/MM are dev accounts (#9 owner stand-in on 143, #0 = deployer = owner on 10143 ownerIsDeployer).
#   chain 10143: the vault attaches to the LIVE testnet perp of deployments/10143.json (state forked, nothing sent).
#   chain 143:   first DeployMeridian perp + swaps (no vault) with the 143 config + owner stand-in, then the vault.
# Output: ../deployments/dry-run/vault-v2-<chain>-fork.json (labelled), ../runs/vault-v2-fork/<date>/ (logs).
set -euo pipefail

RPC="${FORK_RPC_URL:-http://127.0.0.1:8545}"
case "$RPC" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing: FORK_RPC_URL must be localhost" >&2; exit 1 ;;
esac
cast rpc anvil_nodeInfo --rpc-url "$RPC" >/dev/null 2>&1 || { echo "refusing: $RPC is not an anvil node" >&2; exit 1; }
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
case "$CHAIN_ID" in 143|10143) ;; *) echo "refusing: chain id $CHAIN_ID (expected a 143 or 10143 fork)" >&2; exit 1 ;; esac

cd "$(dirname "$0")/../.."   # contracts/
ROOT="$(cd .. && pwd)"
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0 (public dev key)
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                        # anvil #1
MM=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC                            # anvil #2
STANDIN=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720                       # anvil #9
GAS_MULT="${GAS_MULT:-200}"
DATE="$(date -u +%Y-%m-%d)"
OUT_DIR="$ROOT/runs/vault-v2-fork/$DATE"
mkdir -p "$OUT_DIR" "$ROOT/deployments/dry-run"
OUT="dry-run/vault-v2-$CHAIN_ID-fork.json"
CFG="script/config/$CHAIN_ID.json"
BAK="$(mktemp)"
cp "$CFG" "$BAK"
restore() {
  cp "$BAK" "$CFG"; rm -f "$BAK"
  # only the records this run created: DeployMeridian runs here only on 143 (the tracked 10143 record stays)
  local scripts="DeployVaultV2"
  [ "$CHAIN_ID" = "143" ] && scripts="DeployMeridian DeployVaultV2"
  for s in $scripts; do
    if [ -f "broadcast/$s.s.sol/$CHAIN_ID/run-latest.json" ]; then mv "broadcast/$s.s.sol/$CHAIN_ID/run-latest.json" "$OUT_DIR/$s.broadcast.json"; fi
    rm -rf "broadcast/$s.s.sol/$CHAIN_ID" "cache/$s.s.sol/$CHAIN_ID"
  done
}
trap restore EXIT

if [ "$CHAIN_ID" = "143" ]; then
  OWNER=$STANDIN
  jq --arg o "$OWNER" '.owner = $o' "$BAK" > "$CFG"
  DEPLOYER_PK=$PK0 KEEPER_ADDRESS=$KEEPER MM_ADDRESS=$MM DEPLOY_VAULT=0 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=0 \
    REUSE_DEPLOYMENT= DEPLOY_CRE_RECEIVER=false DEPLOY_CONFIG= DEPLOYMENTS_OUT=$OUT \
    forge script script/DeployMeridian.s.sol --rpc-url "$RPC" --broadcast --slow \
    --code-size-limit 131072 --gas-estimate-multiplier "$GAS_MULT" > "$OUT_DIR/perp-143.log" 2>&1
  IN=$OUT
else
  # testnet: the live perp record; the dev deployer becomes the vault owner (config ownerIsDeployer)
  OWNER=$DEV0
  IN=10143.json
fi
ALLOW_FORK_BROADCAST_143=true DEPLOYER_PK=$PK0 KEEPER_ADDRESS=$KEEPER MM_ADDRESS=$MM DEPLOY_CONFIG= DEPLOYMENTS_FILE=$IN \
  DEPLOYMENTS_OUT=$OUT forge script script/DeployVaultV2.s.sol --rpc-url "$RPC" --broadcast --slow \
  --code-size-limit 131072 --gas-estimate-multiplier "$GAS_MULT" 2>&1 | tee "$OUT_DIR/vault-v2-$CHAIN_ID.log" | grep -E "KuruHedger|MeridianVault|owner|vaultStartBlock|gas|ONCHAIN|Error" || true

DEP="$ROOT/deployments/$OUT"
for k in MeridianVault KuruHedger; do
  a="$(jq -r ".contracts.$k // empty" "$DEP")"
  [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "no $k in $DEP (vault deploy failed?)" >&2; exit 1; }
  [ "$(cast code "$a" --rpc-url "$RPC")" != "0x" ] || { echo "no code at $k $a" >&2; exit 1; }
done
jq --arg c "$CHAIN_ID" '{"_label": ("VAULT V2 FORK REHEARSAL (anvil, chain id " + $c + "): NOT a deployment; dev-key actors"), "fork": true} + .' \
  "$DEP" > "$DEP.tmp" && mv "$DEP.tmp" "$DEP"
DEPLOYMENTS_FILE=$OUT EXPECTED_OWNER=$OWNER DEPLOYER_ADDRESS=$DEV0 KEEPER_ADDRESS=$KEEPER MM_ADDRESS=$MM DEPLOY_CONFIG= \
  forge script script/VerifyDeployment.s.sol --rpc-url "$RPC" 2>&1 | tee "$OUT_DIR/verify-$CHAIN_ID.log" | grep -E "PASS|FAIL|SKIP|checks passed" || true
echo "wrote $DEP and $OUT_DIR"
