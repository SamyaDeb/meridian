#!/usr/bin/env python3
"""Regenerates the verbatim section of docs/INTERFACES.md from contracts/src/interfaces/**.sol.
CI runs `python3 tools/gen_interfaces_md.py --check` so the doc can never drift from the code."""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "INTERFACES.md"
SRC = ROOT / "contracts" / "src" / "interfaces"
MARK = "<!-- BEGIN GENERATED: do not edit below; run tools/gen_interfaces_md.py -->"

ORDER = ["MeridianTypes.sol", "IOrderBook.sol", "IMarginEngine.sol", "IClearingHouse.sol", "IFundingRateOracle.sol",
         "IFundingSwapMarket.sol", "IOracleAdapter.sol", "IInsuranceFund.sol", "IMarketFactory.sol", "IMeridianVault.sol",
         "IKuruHedger.sol", "IMeridianKeeperReceiver.sol"]
# interfaces/deferred/** (PT/YT, CR-003) are intentionally excluded from the frozen doc.

def body():
    files = [SRC / f for f in ORDER] + sorted((SRC / "external").glob("*.sol"))
    extra = sorted(set(SRC.glob("*.sol")) - set(SRC / f for f in ORDER))
    out = [MARK, ""]
    for f in files + extra:
        rel = f.relative_to(ROOT)
        out += [f"### `{rel}`", "", "```solidity", f.read_text().rstrip(), "```", ""]
    return "\n".join(out)

def main():
    text = DOC.read_text()
    head = text.split(MARK)[0]
    new = head + body()
    if "--check" in sys.argv:
        if new != text:
            print("docs/INTERFACES.md is stale: run python3 tools/gen_interfaces_md.py"); sys.exit(1)
        return
    DOC.write_text(new)

main()
