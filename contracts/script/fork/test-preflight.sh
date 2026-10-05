#!/usr/bin/env bash
# Tests preflight-143.sh against a LOCAL anvil fork of 143 (Phase 3 P5): it must pass with a correct config (owner =
# the labelled FORK STAND-IN) and refuse a deliberately wrong one. Read-only; temp configs live in script/config/tmp/.
set -uo pipefail
cd "$(dirname "$0")/../.."
RPC="${FORK_RPC_URL:-http://127.0.0.1:8545}"
OWNER=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720   # anvil #9 = FORK STAND-IN, not the real Safe
mkdir -p script/config/tmp
good=script/config/tmp/preflight-good.json; bad=script/config/tmp/preflight-bad.json
jq --arg o "$OWNER" '.owner = $o' script/config/143.json > $good
# prints the env assignments (defaults first; later ones override them in `env`)
base() { echo FORK_REHEARSAL=1 RPC_URL=$RPC DEPLOYER_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 SAFE_ADDRESS=$OWNER \
  KEEPER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 MM_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC "$@"; }
R=0
expect() { # $1 = 0 (pass) | 1 (refuse), $2 = name, rest = env + cmd
  local want=$1 name=$2; shift 2
  out="$(env "$@" bash script/preflight-143.sh 2>&1)"; got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" = "$want" ]; then echo "ok   $name$( [ "$want" = 1 ] && echo " — refused: $(echo "$out" | grep -m1 '^FAIL' )")"; else echo "BAD  $name (exit $got)"; echo "$out" | grep -E 'FAIL|REFUSED|OK'; R=1; fi
}
H=$(shasum -a 256 $good | cut -d' ' -f1)
expect 0 "correct config on the fork" $(base CONFIG=$good EXPECTED_CONFIG_SHA256=$H)
jq '.params.vault.skewCapacity = "800000000000000000"' $good > $bad
expect 1 "skewCapacity 0.8 (hash + invariant)" $(base CONFIG=$bad EXPECTED_CONFIG_SHA256=$(shasum -a 256 $bad | cut -d' ' -f1))
expect 1 "config edited after review (hash)" $(base CONFIG=$bad EXPECTED_CONFIG_SHA256=$H)
jq '.owner = "0x000000000000000000000000000000000000dEaD"' $good > $bad
expect 1 "owner != SAFE_ADDRESS" $(base CONFIG=$bad EXPECTED_CONFIG_SHA256=$(shasum -a 256 $bad | cut -d' ' -f1))
expect 1 "real config: owner null" $(base CONFIG=script/config/143.json EXPECTED_CONFIG_SHA256=$(shasum -a 256 script/config/143.json | cut -d' ' -f1))
expect 1 "keeper = deployer" $(base CONFIG=$good EXPECTED_CONFIG_SHA256=$H KEEPER_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
expect 1 "deployer underfunded" $(base CONFIG=$good EXPECTED_CONFIG_SHA256=$H DEPLOYER_ADDRESS=0x000000000000000000000000000000000000bEEF)
expect 1 "mainnet mode against a fork" $(base CONFIG=$good EXPECTED_CONFIG_SHA256=$H FORK_REHEARSAL=0)
rm -f $good $bad
[ $R = 0 ] && echo "preflight tests: all ok" || { echo "preflight tests: FAILED"; exit 1; }
