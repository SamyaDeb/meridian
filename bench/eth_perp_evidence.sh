#!/bin/bash
# K7 ETH-PERP evidence on Monad testnet: trade -> funding -> forced -15% crash (labelled) -> liquidation -> price restored.
set -euo pipefail
set -a; . "${ENV_FILE:-.env}"; set +a  # DEPLOYER_PK, ETH_VICTIM_PK, ETH_KEEPER_PK, PYTH_API_KEY, MONAD_TESTNET_RPC_URL
R=${RPC:-$MONAD_TESTNET_RPC_URL}
AUSD=0x9739682300022676FF867Ad289d20A8fC08566A1
CH=0xaf250943E173454C2fCD22b4Ba0DF8A0b6E1ccb4; OB=0x77675B68d15A112c9CfC617bCf38aAFA8643BDDe; OR=0x8DFE2185B14b648B4E5d940F025c47AEDEC170Db
FEED=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
D=$(cast wallet address $DEPLOYER_PK); V=$(cast wallet address $ETH_VICTIM_PK); L=$(cast wallet address $ETH_KEEPER_PK)
LOG=$1
log(){ echo "$(date -u +%H:%M:%S) $*" | tee -a $LOG; }
# tx <pk> <label> <to> <sig> args...   (gas = estimate*1.2 + 70k touch allowance; 110 gwei)
tx(){ local pk=$1 label=$2 to=$3; shift 3; local from=$(cast wallet address $pk)
  local est; est=$(cast estimate --from $from $to "$@" -r $R) || { log "$label: estimate failed (would revert), nothing sent"; exit 1; }; local gas=$(( est*12/10 + 70000 ))
  local out=$(cast send --private-key $pk --gas-limit $gas --gas-price 110gwei $to "$@" -r $R --json)
  local h=$(echo "$out" | jq -r .transactionHash) b=$(echo "$out" | jq -r .blockNumber) st=$(echo "$out" | jq -r .status)
  log "$label tx=$h block=$(( b )) status=$st est=$est limit=$gas"; LAST_JSON="$out"; [ "$st" = "0x1" ] || { log "REVERTED"; exit 1; }; }
# "<priceWad> <publishTime>" from Hermes (integer math in python)
hermes(){ curl -s -m 10 -H "Authorization: Bearer $PYTH_API_KEY" "https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids%5B%5D=${FEED#0x}&parsed=true" \
  | python3 -I -c "import json,sys;p=json.load(sys.stdin)['parsed'][0]['price'];print(int(p['price'])*10**(18+p['expo']), p['publish_time'])"; }
push_real(){ read PRICE T < <(hermes); tx $DEPLOYER_PK "push $1 ETH=$PRICE" $OR "pushPrice(uint256,uint256)" $PRICE $T; }
OBL=$(echo $OB | tr A-Z a-z)
oid(){ echo "$LAST_JSON" | jq -r '.logs[] | select((.address|ascii_downcase)=="'$OBL'") | select(.topics|length==3) | .topics[1]' | head -1 | xargs cast to-dec; }
pay(){ local out=$(cast send --private-key $DEPLOYER_PK --gas-limit 21000 --gas-price 110gwei $1 --value $2 -r $R --json); log "$3 tx=$(echo "$out" | jq -r .transactionHash) block=$(( $(echo "$out" | jq -r .blockNumber) )) status=$(echo "$out" | jq -r .status)"; }
tick(){ cast call $OR "tryGetIndexPrice()(bool,uint256,uint256)" -r $R | sed -n 2p | awk '{print $1}' | python3 -I -c "import sys;print(int(sys.stdin.read().strip())//10**17)"; }
acct(){ cast call $CH "getAccount(address)((uint256,int256,uint256,int256,int256,int256,uint256,uint256,uint256,uint256,bool))" $1 -r $R; }

log "== K7 ETH-PERP evidence: deployer(maker+feeder) $D victim $V liquidator(ETH keeper) $L"
pay $V 0.06ether "fund victim 0.06 MON"
pay $L 0.05ether "fund liquidator 0.05 MON"
tx $DEPLOYER_PK "mint 430 tAUSD" $AUSD "mint(address,uint256)" $D 430000000
tx $DEPLOYER_PK "approve CH" $AUSD "approve(address,uint256)" $CH 430000000
tx $DEPLOYER_PK "depositFor maker 300" $CH "depositFor(address,uint256)" $D 300000000
tx $DEPLOYER_PK "depositFor victim 30" $CH "depositFor(address,uint256)" $V 30000000
tx $DEPLOYER_PK "depositFor liquidator 100" $CH "depositFor(address,uint256)" $L 100000000
push_real "pre-trade"
T0=$(tick); log "index tick $T0"
tx $DEPLOYER_PK "maker ask 55 lots @t+2" $OB "placeLimitOrder(bool,uint32,uint64,uint8)" false $((T0+2)) 55 0
tx $ETH_VICTIM_PK "TRADE victim market buy 55 lots (0.055 ETH)" $OB "placeMarketOrder(bool,uint64,uint32,uint64,bool)" true 55 $((T0+10)) 55 false
tx $DEPLOYER_PK "maker bid 5 @t-1" $OB "placeLimitOrder(bool,uint32,uint64,uint8)" true $((T0-1)) 5 0; BID=$(oid)
tx $DEPLOYER_PK "maker ask 5 @t+3" $OB "placeLimitOrder(bool,uint32,uint64,uint8)" false $((T0+3)) 5 0; ASK=$(oid)
log "victim after trade: $(acct $V)"
log "funding state 0: $(cast call $CH 'fundingState()((int256,int256,int256,int256,uint64))' -r $R)"
for i in 1 2 3; do sleep 20; push_real "keepalive $i"; tx $DEPLOYER_PK "FUNDING poke $i" $CH "updateFunding()"; done
log "funding state 1: $(cast call $CH 'fundingState()((int256,int256,int256,int256,uint64))' -r $R)"
log "victim after funding: $(acct $V)"
tx $DEPLOYER_PK "cancel bid" $OB "cancelOrder(uint64)" $BID
tx $DEPLOYER_PK "cancel ask" $OB "cancelOrder(uint64)" $ASK
read P T < <(hermes)
CP=$(python3 -I -c "print($P*85//100)"); NOW=$(cast block latest -f timestamp -r $R)
tx $DEPLOYER_PK "CRASH forced -15% feed (labelled test push) ETH=$CP" $OR "pushPrice(uint256,uint256)" $CP $NOW
T1=$(tick); log "crash index tick $T1"
tx $DEPLOYER_PK "maker re-quote bid @t1-1" $OB "placeLimitOrder(bool,uint32,uint64,uint8)" true $((T1-1)) 5 0; BID=$(oid)
tx $DEPLOYER_PK "maker re-quote ask @t1+1" $OB "placeLimitOrder(bool,uint32,uint64,uint8)" false $((T1+1)) 5 0; ASK=$(oid)
log "liquidatable: $(cast call $CH 'isLiquidatable(address)(bool)' $V -r $R)"
log "IF before $(cast call 0xCcd97285dD2fca8D028D880Ed754039118437b48 'balance()(uint256)' -r $R)"
tx $ETH_KEEPER_PK "LIQUIDATION victim (liquidator = ETH keeper key)" $CH "liquidate(address,uint256)" $V 115792089237316195423570985008687907853269984665640564039457584007913129639935
log "IF after $(cast call 0xCcd97285dD2fca8D028D880Ed754039118437b48 'balance()(uint256)' -r $R)"
log "victim after liquidation: $(acct $V)"
log "liquidator: $(acct $L)"
tx $DEPLOYER_PK "cancel crash bid" $OB "cancelOrder(uint64)" $BID
tx $DEPLOYER_PK "cancel crash ask" $OB "cancelOrder(uint64)" $ASK
sleep 2; push_real "RESTORE real price"
log "done; deployer MON $(cast balance --ether $D -r $R)"
