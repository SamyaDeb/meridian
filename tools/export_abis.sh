#!/usr/bin/env bash
# Writes abis/<Contract>.json (plain ABI arrays) from contracts/out for the TS packages (@meridian/abis).
# Exported: frozen interfaces (+ external), mocks, and implementations as they merge.
# Usage: bash tools/export_abis.sh   (CI checks the output is committed and up to date)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/contracts" && forge build --silent)
python3 - "$ROOT" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
src, out, dst = root / "contracts/src", root / "contracts/out", root / "abis"
# deferred/ (PT/YT) is not part of the product surface.
dirs = ["interfaces", "interfaces/external", "mocks", "orderbook", "clearing", "oracle", "automation", "vault", "swaps"]
wanted = {}
for d in dirs:
    for f in sorted((src / d).glob("*.sol")) if (src / d).is_dir() else []:
        wanted[f.name] = f.stem  # one contract per file; file name = contract name (CLAUDE.md §3)
for old in dst.glob("*.json"):
    if old.name != "package.json":
        old.unlink()
n = 0
for fname, name in sorted(wanted.items()):
    art = out / fname / f"{name}.json"
    if not art.exists():
        continue  # e.g. MeridianTypes.sol has no contract named MeridianTypes
    abi = json.loads(art.read_text())["abi"]
    if not abi:
        continue
    (dst / f"{name}.json").write_text(json.dumps(abi, indent=2) + "\n")
    n += 1
print(f"export_abis: wrote {n} ABIs to abis/")
PY
