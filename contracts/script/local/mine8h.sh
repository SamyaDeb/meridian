#!/usr/bin/env bash
# 8 h of per-block funding history on the local anvil: every iteration = feeder push + funding poke + 198 empty blocks
# (timestamp frozen: anvil_mine interval 0), so a checkpoint lands in (almost) every 200-block bucket.
R=http://127.0.0.1:8546
DEP=${DEP:-$(dirname "$0")/../../../deployments/anvil-10143.json}
OR=$(jq -r .contracts.OracleAdapter $DEP); CH=$(jq -r .contracts.ClearingHouse $DEP)
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
start=$(cast bn -r $R); target=$((start + ${BLOCKS:-97000}))
i=0
while [ "$(cast bn -r $R)" -lt $target ]; do
  ts=$(cast block -r $R latest -f timestamp)
  cast send --async -r $R --private-key $K0 $OR "pushPrice(uint256,uint256)" 26600000000000000 $ts >/dev/null
  cast send --async -r $R --private-key $K1 $CH "updateFunding()" >/dev/null
  cast rpc -r $R anvil_mine 0xc6 0x0 >/dev/null
  i=$((i+1)); [ $((i % 50)) -eq 0 ] && echo "iter $i block $(cast bn -r $R)"
done
echo "done: blocks $start..$(cast bn -r $R)"
