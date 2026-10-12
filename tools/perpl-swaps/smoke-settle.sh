#!/usr/bin/env bash
# PS Phase 2 smoke, part 2: wait for Perpl's next funding event to apply, poke, settle both, check by hand.
set -euo pipefail
ENVF=${ENV_FILE:-.env} # keys are read from this file, never printed
val() { grep "^$1=" "$ENVF" | cut -d= -f2- | tr -d '"'"'"; }
RPC=$(val MONAD_TESTNET_RPC_URL)
PUB=https://testnet-rpc.monad.xyz
DEP=$(val DEPLOYER_PK)
X=0x1964c32f0be608e7d29302aff5e61268e72080cc
S=0xC008aF47fCC651889a1d66f0734da941A55224cC
FS=0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde
LONG_A=0xe7D75c6751e3Da7323fa7702DA273408ba7cdB08
SHORT_A=0xB1a78a9cB3FE3aB4f0c49ad0dBC080EF18305bd1
LAST=$(cast call $S 'latestObservation()(int256,int256,uint64)' --rpc-url $PUB | sed -n 3p | awk '{print $1}')
echo "adapter feb before: $LAST"
while :; do
  feb=$(cast call $X 'getFundingSumAtBlock(uint256,uint256)(int48,uint256)' 64 "$(cast block-number --rpc-url $PUB)" --rpc-url $PUB | sed -n 2p | awk '{print $1}')
  [ "$feb" -gt "$LAST" ] && break
  sleep 15
done
echo "perpl applied feb $feb"
obs0=$(cast call $S 'latestObservation()(int256,int256,uint64)' --rpc-url $PUB | awk '{print $1}' | tr '\n' ' ')
cl0=$(cast call $FS 'collateralOf(address)(int256)' $LONG_A --rpc-url $PUB | awk '{print $1}')
cs0=$(cast call $FS 'collateralOf(address)(int256)' $SHORT_A --rpc-url $PUB | awk '{print $1}')
send() {
  local to=$1 sig=$2; shift 2
  local from; from=$(cast wallet address --private-key "$DEP")
  local est; est=$(cast estimate --from "$from" "$to" "$sig" "$@" --rpc-url "$RPC")
  local lim=$(( est * 12 / 10 ))
  local out; out=$(cast send --private-key "$DEP" --gas-limit "$lim" --gas-price 110gwei "$to" "$sig" "$@" --rpc-url "$RPC" --json)
  echo "$(echo "$out" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"], int(r["blockNumber"],16), r["status"])') $sig $* est=$est limit=$lim"
}
send $S 'poke()'
obs1=$(cast call $S 'latestObservation()(int256,int256,uint64)' --rpc-url $PUB | awk '{print $1}' | tr '\n' ' ')
send $FS 'settle(address)' $LONG_A
send $FS 'settle(address)' $SHORT_A
cl1=$(cast call $FS 'collateralOf(address)(int256)' $LONG_A --rpc-url $PUB | awk '{print $1}')
cs1=$(cast call $FS 'collateralOf(address)(int256)' $SHORT_A --rpc-url $PUB | awk '{print $1}')
pl=$(cast call $FS 'getPosition(address)((int256,int256,int256,int256))' $LONG_A --rpc-url $PUB)
echo "obs before: $obs0"
echo "obs after:  $obs1"
echo "collateral long  $cl0 -> $cl1"
echo "collateral short $cs0 -> $cs1"
echo "long position after settle: $pl"
python3 - "$obs0" "$obs1" "$cl0" "$cl1" "$cs0" "$cs1" <<'PY'
import sys
f0,g0,b0=map(int,sys.argv[1].split()); f1,g1,b1=map(int,sys.argv[2].split())
cl0,cl1,cs0,cs1=map(int,sys.argv[3:7])
q=10_000*10**18; K=q//10; YEAR=31_536_000
dF,dG=f1-f0,g1-g0
def floordiv(n,d): return n//d
netL=floordiv(q*dF*YEAR-K*dG,10**18*YEAR); netS=floordiv(-q*dF*YEAR+K*dG,10**18*YEAR)
print(f"dF={dF} dG={dG} feb {b0}->{b1}")
print(f"floating(long)=q*dF/1e18={q*dF/1e18/1e18:.12f} AUSD  fixed(long)=K*dG/(1e18*YEAR)={K*dG/1e18/YEAR/1e18:.12f} AUSD")
print(f"expected net long {netL} short {netS}; observed long {cl1-cl0} short {cs1-cs0}")
print("MATCH" if (cl1-cl0)==netL and (cs1-cs0)==netS else "MISMATCH", "dust", -(netL+netS))
PY
