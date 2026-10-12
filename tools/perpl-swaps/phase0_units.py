"""Phase 0 (PS, docs/PERPL_SWAPS.md §Units): Perpl funding units, sign, price source, boundary, history depth, gas. Read-only.
Usage: python3 -I tools/perpl-swaps/phase0_units.py <n_events> <out.json>"""
import json, sys, time, urllib.request
from eth_abi import encode, decode
from eth_utils import keccak

RPC = "https://testnet-rpc.monad.xyz"  # docs/ARCHITECTURE.md R29 (read-only)
X = "0x1964c32f0be608e7d29302aff5e61268e72080cc"
PERP = 64
N = int(sys.argv[1]) if len(sys.argv) > 1 else 24

def rpc(method, params, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if "error" in r:
                raise RuntimeError(r["error"])
            return r["result"]
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(0.5 * (i + 1))

def sel(sig):
    return keccak(text=sig)[:4]

def call(sig, types, args, out, block="latest"):
    data = "0x" + (sel(sig) + encode(types, args)).hex()
    res = rpc("eth_call", [{"to": X, "data": data}, hex(block) if isinstance(block, int) else block])
    return decode(out, bytes.fromhex(res[2:]))

def est(sig, types, args):
    data = "0x" + (sel(sig) + encode(types, args)).hex()
    return int(rpc("eth_estimateGas", [{"to": X, "data": data}]), 16)

INFO_T = "(string,string,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int16,uint256,uint8,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256)"
def info(block="latest"):
    t = call("getPerpetualInfoV2(uint256)", ["uint256"], [PERP], [INFO_T], block)[0]
    return {"pd": t[2], "markPNS": t[11], "markTs": t[12], "oraclePNS": t[15], "oracleTs": t[16], "rate": t[20], "clamp": t[21], "status": t[22], "ignOracle": t[29], "exp": t[30], "refMaxAge": t[8]}

def fsum(blk, at="latest"):
    return call("getFundingSumAtBlock(uint256,uint256)", ["uint256", "uint256"], [PERP, blk], ["int48", "uint256"], at)

TOPIC = "0x" + keccak(text="FundingEventCompleted(uint256,uint256,int256,int256,uint256,int48,int48,bool)").hex()

def logs_for(feb):
    out = []
    for lo in range(feb - 200, feb + 1, 100):
        L = rpc("eth_getLogs", [{"address": X, "topics": [TOPIC], "fromBlock": hex(lo), "toBlock": hex(min(lo + 99, feb))}])
        for l in L:
            raw = bytes.fromhex(l["data"][2:])
            topics = l["topics"]
            # perpId is not indexed in the ABI; decode all 8 fields from data
            v = decode(["uint256", "uint256", "int256", "int256", "uint256", "int48", "int48", "bool"], raw)
            if v[0] == PERP and v[1] == feb:
                out.append({"block": int(l["blockNumber"], 16), "tx": l["transactionHash"], "spec": v[2], "rate": v[3], "pricePNS": v[4], "ppl": v[5], "sum": v[6], "overwrite": v[7]})
    return out

head = int(rpc("eth_blockNumber", []), 16)
now = info()
print("head", head, "info", now)
interval = call("getFundingInterval()", [], [], ["uint256"])[0]
print("interval blocks", interval)
scale = 10 ** (18 - now["pd"] - now["exp"])
print("scale F_wad = sum *", scale)

# walk back N events
s, feb = fsum(head)
chain = [(feb, s)]
for _ in range(N):
    s, feb = fsum(feb - 1)
    chain.append((feb, s))
chain.reverse()

rows = []
for i in range(1, len(chain)):
    feb, s = chain[i]
    pf, ps = chain[i - 1]
    lg = logs_for(feb)
    ev = lg[-1] if lg else None
    r = {"feb": feb, "sum": s, "dSum": s - ps, "dFeb": feb - pf}
    if ev:
        B = ev["block"]
        at = info(B)
        before = info(B - 1)
        exact = ev["rate"] * ev["pricePNS"] * 10 ** now["exp"]
        trunc = abs(exact) // 100000 * (1 if exact >= 0 else -1)
        price_wad = ev["pricePNS"] * 10 ** (18 - now["pd"])
        lhs = (s - ps) * scale  # ΔF wad
        rhs_exact = ev["rate"] * price_wad / 1e5  # rate/1e5 * price_wad
        r.update({
            "emitBlock": B, "lead": feb - B, "tx": ev["tx"], "rate": ev["rate"], "spec": ev["spec"], "pricePNS": ev["pricePNS"], "ppl": ev["ppl"],
            "evSum": ev["sum"], "overwrite": ev["overwrite"], "nLogs": len(lg),
            "dSum==ppl": (s - ps) == ev["ppl"], "evSum==view": ev["sum"] == s,
            "ppl==trunc0(rate*price*10^exp/1e5)": ev["ppl"] == trunc,
            "dF_wad": lhs, "rate*price_wad/1e5": rhs_exact, "absErr_wad": abs(lhs - rhs_exact), "errBound_wad": scale,
            "mark@B-1": before["markPNS"], "oracle@B-1": before["oraclePNS"], "mark@B": at["markPNS"], "oracle@B": at["oraclePNS"],
            "nextRate@B-1": before["rate"], "nextRate@B": at["rate"],
            # visibility: what the head-view returns at B-1 and at B
            "view@B-1": fsum(B - 1, B - 1), "view@B": fsum(B, B), "view@feb-1": fsum(feb - 1, feb - 1),
        })
    rows.append(r)
    print(json.dumps(r, default=str))

# history depth
for label, back in [("1d", 288000), ("7d", 2016000), ("30d", 8640000)]:
    try:
        print("history", label, back, fsum(head - back))
    except Exception as e:
        print("history", label, "ERR", e)
# gas
print("gas getFundingSumAtBlock", est("getFundingSumAtBlock(uint256,uint256)", ["uint256", "uint256"], [PERP, head]))
print("gas getFundingSumAtBlock(head-96000)", est("getFundingSumAtBlock(uint256,uint256)", ["uint256", "uint256"], [PERP, head - 96000]))
print("gas getPerpetualInfoV2", est("getPerpetualInfoV2(uint256)", ["uint256"], [PERP]))
json.dump({"head": head, "info": now, "interval": interval, "scale": scale, "rows": rows}, open(sys.argv[2] if len(sys.argv) > 2 else "phase0.json", "w"), default=str, indent=1)
