#!/usr/bin/env bash
# PS Phase 2 smoke, part 1: fund, deposit, one long (ETH_VICTIM, taker) and one short (DEMO_MM, maker) on the
# Perpl-funding swap book. Keys come from Meridian/.env and are never printed. Gas limit = estimate × 1.2.
set -euo pipefail
ENVF=${ENV_FILE:-.env} # keys are read from this file, never printed
val() { grep "^$1=" "$ENVF" | cut -d= -f2- | tr -d '"'"'"; }
RPC=$(val MONAD_TESTNET_RPC_URL)
DEP=$(val DEPLOYER_PK); LONG=$(val ETH_VICTIM_PK); SHORT=$(val DEMO_MM_PK)
AUSD=0x9739682300022676FF867Ad289d20A8fC08566A1
FS=0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde
OB=0x5D4f03B6Afa525ed580C75878A2F51A35c202334
LONG_A=$(cast wallet address --private-key "$LONG"); SHORT_A=$(cast wallet address --private-key "$SHORT")
echo "long $LONG_A short $SHORT_A"

send() { # pk to sig args...
  local pk=$1 to=$2 sig=$3; shift 3
  local from; from=$(cast wallet address --private-key "$pk")
  local est; est=$(cast estimate --from "$from" "$to" "$sig" "$@" --rpc-url "$RPC")
  local lim=$(( est * 12 / 10 ))
  local out; out=$(cast send --private-key "$pk" --gas-limit "$lim" --gas-price 110gwei "$to" "$sig" "$@" --rpc-url "$RPC" --json)
  echo "$(echo "$out" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"], int(r["blockNumber"],16), r["status"])') $sig est=$est limit=$lim"
}

if [ "${1:-}" = "fund" ]; then
  out=$(cast send --private-key "$DEP" --value 0.4ether --gas-price 110gwei "$LONG_A" --rpc-url "$RPC" --json)
  echo "fund $(echo "$out" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"], int(r["blockNumber"],16), r["status"])') 0.4 MON deployer -> long"
fi
for pk in "$LONG" "$SHORT"; do
  a=$(cast wallet address --private-key "$pk")
  send "$pk" $AUSD 'mint(address,uint256)' "$a" 1000000000
  send "$pk" $AUSD 'approve(address,uint256)' $FS 1000000000
  send "$pk" $FS 'deposit(uint256)' 1000000000
done
# short (maker): ask 10 lots (10,000 MON) at 10.00% APR = price 1.10 = tick 11,000
send "$SHORT" $OB 'placeLimitOrder(bool,uint32,uint64,uint8)' false 11000 10 0
# long (taker): buy 10 lots, worst tick 11,000, all-or-nothing
send "$LONG" $OB 'placeMarketOrder(bool,uint64,uint32,uint64,bool)' true 10 11000 10 false
cast call $FS 'getPosition(address)((int256,int256,int256,int256))' "$LONG_A" --rpc-url "$RPC"
cast call $FS 'getPosition(address)((int256,int256,int256,int256))' "$SHORT_A" --rpc-url "$RPC"
echo "block $(cast block-number --rpc-url "$RPC")"
