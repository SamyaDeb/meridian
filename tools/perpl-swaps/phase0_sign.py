"""Phase 0 sign check: premiumPnlCNS of every perp-64 position across funding events. Usage: phase0_sign.py feb:rate ..."""
import json, urllib.request, sys
from eth_abi import encode, decode
from eth_utils import keccak
RPC="https://testnet-rpc.monad.xyz"; X="0x1964c32f0be608e7d29302aff5e61268e72080cc"
def rpc(m,p):
    r=json.load(urllib.request.urlopen(urllib.request.Request(RPC,json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),{"content-type":"application/json"}),timeout=30))
    if "error" in r: raise RuntimeError(r["error"])
    return r["result"]
POS="(uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,int256,int256,int256,uint256)"
def positions(block):
    data="0x"+(keccak(text="getPositionsV2(uint256,uint256,uint256)")[:4]+encode(["uint256"]*3,[64,0,30])).hex()
    res=rpc("eth_call",[{"to":X,"data":data},hex(block)])
    return decode([POS+"[]","uint256","uint256","bool"],bytes.fromhex(res[2:]))
for feb,rate in [(int(a),int(b)) for a,b in (x.split(':') for x in sys.argv[1:])]:
    a=positions(feb-1); b=positions(feb)
    pa={p[0]:p for p in a[0]}; pb={p[0]:p for p in b[0]}
    print("feb",feb,"rate",rate,"n",len(pa),"mark",a[2],b[2])
    for k in pa:
        if k in pb and pa[k][6]==pb[k][6] and pa[k][3]==pb[k][3]:
            d=pb[k][10]-pa[k][10]
            print(f"  acct {k} type {pa[k][3]} ({'Long' if pa[k][3]==0 else 'Short'}) lots {pa[k][6]} dPremiumPnlCNS {d} dPnl {pb[k][8]-pa[k][8]} dDeposit {pb[k][4]-pa[k][4]}")
