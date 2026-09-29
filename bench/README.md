# bench/ (WS-08)

Every reported number carries network, block range, commit hash and date (BENCHMARKS_PLAN).

| ID | Command | Output |
|---|---|---|
| B6 √τ chart | `pip install -r bench/requirements.txt && python3 bench/sqrt_tau.py` | `bench/out/sqrt_tau.{png,csv}`; exits 1 if the numbers drift from MATH_SPEC §3.4 |

`python3 bench/sqrt_tau.py --no-plot` needs only the stdlib (CSV + spec check).
