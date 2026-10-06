#!/usr/bin/env bash
# Mainnet-day PREFLIGHT for DeployMeridian on 143 (Phase 3 P5). READ-ONLY: sends nothing, signs nothing, reads no key.
# Refuses (exit 1) unless every check passes. Run it immediately before the broadcast, from contracts/:
#
#   RPC_URL=<paid mainnet endpoint> DEPLOYER_ADDRESS=0x… SAFE_ADDRESS=0x… KEEPER_ADDRESS=0x… MM_ADDRESS=0x… \
#   EXPECTED_CONFIG_SHA256=<sha256 of the reviewed config/143.json> [SAFE_OWNERS=0xA,0xB,0xC] [MIN_DEPLOYER_MON=12] \
#     bash script/preflight-143.sh
#
# Checks: the RPC is chain 143 and NOT an anvil fork; the config file's sha256 equals the reviewed hash; config
# invariants (owner = SAFE_ADDRESS, AUSD R9, depositCap 1,200 AUSD, skewCapacity 0, oracle 60 s / 3%, no demo market);
# the Safe has code, getThreshold() = 2 and 3 owners (= SAFE_OWNERS when given); keeper / MM set, distinct, not the
# deployer, not the Safe; the deployer holds ≥ MIN_DEPLOYER_MON (default 12 = 2 × the fork-measured 55.1 M gas limit
# at 102 gwei, ×200 multiplier); deployments/143.json does not already record a deployment.
#
# FORK_REHEARSAL=1 (tests only): the RPC must be a LOCAL anvil instead, and SAFE_ADDRESS may be an EOA stand-in
# (Safe checks are reported as SKIPPED — FORK STAND-IN, not the real Safe). CONFIG overrides the config path.
set -uo pipefail
cd "$(dirname "$0")/.."   # contracts/

FAILS=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
need() { [ -n "${!1:-}" ] || { echo "FAIL missing env $1"; exit 1; }; }
lc() { tr '[:upper:]' '[:lower:]'; }

need RPC_URL; need DEPLOYER_ADDRESS; need SAFE_ADDRESS; need KEEPER_ADDRESS; need MM_ADDRESS; need EXPECTED_CONFIG_SHA256
CONFIG="${CONFIG:-script/config/143.json}"
MIN_MON="${MIN_DEPLOYER_MON:-12}"
FORK="${FORK_REHEARSAL:-0}"

# 1. network
CID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || echo none)"
[ "$CID" = "143" ] && pass "chain id 143" || fail "chain id is $CID, expected 143"
if cast rpc anvil_nodeInfo --rpc-url "$RPC_URL" >/dev/null 2>&1; then IS_ANVIL=1; else IS_ANVIL=0; fi
if [ "$FORK" = "1" ]; then
  case "$RPC_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) fail "FORK_REHEARSAL needs a localhost RPC" ;; esac
  [ "$IS_ANVIL" = 1 ] && pass "FORK_REHEARSAL: local anvil fork (labelled)" || fail "FORK_REHEARSAL but the RPC is not anvil"
else
  [ "$IS_ANVIL" = 0 ] && pass "RPC is not an anvil fork" || fail "RPC answers anvil_nodeInfo: this is a fork, not mainnet"
fi

# 2. config hash + invariants
[ -f "$CONFIG" ] || { fail "config $CONFIG missing"; echo "preflight: $FAILS failure(s)"; exit 1; }
SHA="$(shasum -a 256 "$CONFIG" | cut -d' ' -f1)"
[ "$SHA" = "$(echo "$EXPECTED_CONFIG_SHA256" | lc)" ] && pass "config sha256 $SHA" || fail "config sha256 $SHA != expected"
jqv() { jq -r "$1" "$CONFIG"; }
[ "$(jqv .chainId)" = 143 ] && pass "config chainId 143" || fail "config chainId $(jqv .chainId)"
[ "$(jqv .owner | lc)" = "$(echo "$SAFE_ADDRESS" | lc)" ] && pass "config owner = SAFE_ADDRESS" || fail "config owner $(jqv .owner) != SAFE_ADDRESS"
[ "$(jqv '.ownerIsDeployer // false')" = false ] && pass "no ownerIsDeployer" || fail "ownerIsDeployer set"
[ "$(jqv '.demoMarket.enabled // false')" = false ] && pass "no demo market" || fail "demo market enabled"
[ "$(jqv .tokens.AUSD)" = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a ] && pass "AUSD = R9" || fail "AUSD $(jqv .tokens.AUSD)"
[ "$(jqv .params.vault.depositCap)" = 1200000000 ] && pass "vault depositCap 1,200 AUSD (decision 12)" || fail "depositCap $(jqv .params.vault.depositCap)"
[ "$(jqv .params.vault.skewCapacity)" = 0 ] && pass "vault skewCapacity 0 (idle, decision 17)" || fail "skewCapacity $(jqv .params.vault.skewCapacity)"
[ "$(jqv .params.oracle.kind)" = pyth ] && pass "oracle kind pyth" || fail "oracle kind $(jqv .params.oracle.kind)"
[ "$(jqv .params.oracle.maxStalenessSec)" = 60 ] && pass "oracle staleness 60 s" || fail "staleness $(jqv .params.oracle.maxStalenessSec)"
[ "$(jqv .params.oracle.maxDeviationWad)" = 30000000000000000 ] && pass "oracle deviation 3%" || fail "deviation $(jqv .params.oracle.maxDeviationWad)"

# 3. the Safe
SAFE_CODE="$(cast code "$SAFE_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || echo 0x)"
if [ "$FORK" = "1" ] && [ "$SAFE_CODE" = "0x" ]; then
  echo "SKIPPED Safe checks: $SAFE_ADDRESS is an EOA — FORK STAND-IN, not the real Safe (HUMAN_CHECKLIST #3)"
else
  [ "$SAFE_CODE" != "0x" ] && pass "Safe has code" || fail "SAFE_ADDRESS has no code"
  TH="$(cast call "$SAFE_ADDRESS" 'getThreshold()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null | cut -d' ' -f1)"
  [ "$TH" = 2 ] && pass "Safe threshold 2" || fail "Safe threshold '${TH:-none}' != 2"
  OWNERS="$(cast call "$SAFE_ADDRESS" 'getOwners()(address[])' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[] ' | lc)"
  N="$(echo "$OWNERS" | tr ',' '\n' | grep -c '^0x' || true)"
  [ "$N" = 3 ] && pass "Safe has 3 owners" || fail "Safe owners count '$N' != 3"
  if [ -n "${SAFE_OWNERS:-}" ]; then
    WANT="$(echo "$SAFE_OWNERS" | lc | tr ',' '\n' | sort | tr '\n' ',')"
    GOT="$(echo "$OWNERS" | tr ',' '\n' | sort | tr '\n' ',')"
    [ "$WANT" = "$GOT" ] && pass "Safe owners = SAFE_OWNERS" || fail "Safe owners differ from SAFE_OWNERS"
  fi
fi

# 4. roles
D="$(echo "$DEPLOYER_ADDRESS" | lc)"; K="$(echo "$KEEPER_ADDRESS" | lc)"; M="$(echo "$MM_ADDRESS" | lc)"; S="$(echo "$SAFE_ADDRESS" | lc)"
[ "$K" != "$D" ] && [ "$M" != "$D" ] && [ "$K" != "$M" ] && [ "$S" != "$D" ] && [ "$S" != "$K" ] && [ "$S" != "$M" ] \
  && pass "deployer / keeper / MM / Safe all distinct" || fail "deployer, keeper, MM and Safe must be four distinct addresses"

# 5. deployer funds
BAL="$(cast balance "$DEPLOYER_ADDRESS" --ether --rpc-url "$RPC_URL" 2>/dev/null || echo 0)"
awk -v b="$BAL" -v m="$MIN_MON" 'BEGIN{exit !(b+0 >= m+0)}' && pass "deployer holds $BAL MON (≥ $MIN_MON)" || fail "deployer holds $BAL MON (< $MIN_MON)"

# 6. no existing record
REC=../deployments/143.json
if [ -f "$REC" ] && [ "$(jq -r '.deployed // false' "$REC")" = true ]; then fail "deployments/143.json already records a deployment"; else pass "no existing 143 deployment record"; fi

echo "preflight: $FAILS failure(s)"
[ "$FAILS" = 0 ] && echo "PREFLIGHT OK" || { echo "PREFLIGHT REFUSED"; exit 1; }
