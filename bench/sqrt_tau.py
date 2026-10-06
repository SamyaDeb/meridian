#!/usr/bin/env python3
"""B6: the sqrt(tau) margin chart (MATH_SPEC §3.4, BENCHMARKS_PLAN B6).

mmr = z * sigma * sqrt(tau / YEAR), z = 3, YEAR = 365 d.
Writes bench/out/sqrt_tau.csv and bench/out/sqrt_tau.png and exits non-zero if
the computed table drifts from the MATH_SPEC §3.4 numbers.

Usage:  python3 bench/sqrt_tau.py            (needs matplotlib + numpy)
        python3 bench/sqrt_tau.py --no-plot  (CSV + check only, stdlib)
"""

import csv
import math
import sys
from pathlib import Path

YEAR_S = 365 * 24 * 3600  # 31,536,000 s
Z = 3.0
SIGMAS = (0.50, 1.00, 1.50)  # annualized vol

# (label, tau seconds) - the MATH_SPEC §3.4 rows, in table order
DESIGNS = (
    ("Monad, 1 block", 0.3),
    ("Monad, 3 blocks", 0.9),
    ("Monad, keeper ~2 s", 2.0),
    ("Ethereum L1 block", 12.0),
    ("1-minute", 60.0),
    ("Hourly", 3600.0),
    ("8-hour", 28800.0),
)

# MATH_SPEC §3.4, in percent, rounded to 3 dp as printed there
SPEC_SIGMA_100 = {0.3: 0.029, 0.9: 0.051, 2.0: 0.076, 12.0: 0.185, 60.0: 0.414, 3600.0: 3.205, 28800.0: 9.066}
SPEC_SIGMA_50 = {0.3: 0.015, 0.9: 0.025, 3600.0: 1.603, 28800.0: 4.533}
SPEC_SIGMA_150 = {0.3: 0.044, 0.9: 0.076, 3600.0: 4.808, 28800.0: 13.599}

CAVEAT = (
    "Caveat: the hourly/8 h rows model designs where risk state (mark, funding, settlement) refreshes only at that "
    "interval. Most CEX/perp DEXs liquidate continuously, so their tau is keeper latency, not the funding interval. "
    "Our claim is narrower: on Monad, funding, mark and liquidation eligibility all update every block. "
    "Meridian still sets mmr = 10% (5x max) at launch because thin liquidity (impact) dominates."
)

OUT = Path(__file__).resolve().parent / "out"


def mmr(sigma: float, tau_s: float) -> float:
    """MATH_SPEC §3.4: z*sigma*sqrt(tau/YEAR), as a fraction."""
    return Z * sigma * math.sqrt(tau_s / YEAR_S)


def check() -> list[str]:
    errors = []
    for sigma, spec in ((1.00, SPEC_SIGMA_100), (0.50, SPEC_SIGMA_50), (1.50, SPEC_SIGMA_150)):
        for tau, pct in spec.items():
            got = round(mmr(sigma, tau) * 100, 3)
            if got != pct:
                errors.append(f"sigma={sigma:.0%} tau={tau}s: computed {got}% != MATH_SPEC {pct}%")
    return errors


def write_csv() -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "sqrt_tau.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["design", "tau_s", "mmr_pct_sigma50", "mmr_pct_sigma100", "mmr_pct_sigma150", "max_leverage_sigma100"])
        for label, tau in DESIGNS:
            m = [mmr(s, tau) for s in SIGMAS]
            w.writerow([label, tau, *(f"{x * 100:.3f}" for x in m), f"{1 / m[1]:.0f}"])
    return path


def print_table() -> None:
    print(f"{'design':<22}{'tau (s)':>9}{'s=50%':>9}{'s=100%':>9}{'s=150%':>10}{'max lev':>9}")
    for label, tau in DESIGNS:
        m = [mmr(s, tau) * 100 for s in SIGMAS]
        print(f"{label:<22}{tau:>9g}{m[0]:>8.3f}%{m[1]:>8.3f}%{m[2]:>9.3f}%{100 / m[1]:>8.0f}x")
    print()
    print(CAVEAT)


def plot() -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.ticker import FuncFormatter

    # dataviz reference palette, light mode, slots 1-3 (validated all-pairs)
    surface, ink, ink2, grid = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
    series = {0.50: "#1baf7a", 1.00: "#2a78d6", 1.50: "#eb6834"}
    styles = {0.50: (0, (4, 2)), 1.00: "solid", 1.50: (0, (1, 1.5))}  # secondary encoding

    fig, ax = plt.subplots(figsize=(10, 6.2), dpi=160)
    fig.patch.set_facecolor(surface)
    ax.set_facecolor(surface)

    taus = np.logspace(math.log10(0.3), math.log10(28800), 400)
    for s in SIGMAS:
        y = Z * s * np.sqrt(taus / YEAR_S) * 100
        ax.plot(taus, y, color=series[s], lw=2, ls=styles[s], label=f"σ = {s:.0%}", solid_capstyle="round")
        ax.annotate(f"σ = {s:.0%}", (taus[-1], y[-1]), xytext=(6, 0), textcoords="offset points",
                    va="center", fontsize=9, color=ink2)

    for label, tau in DESIGNS:
        y = mmr(1.00, tau) * 100
        ax.plot([tau], [y], "o", ms=8, color=series[1.00], mec=surface, mew=2, zorder=3)
        ax.axvline(tau, color=grid, lw=1, zorder=0)
        last = tau == DESIGNS[-1][1]  # 8 h label goes left; 0.9 s label is staggered below the 2 s one
        ax.annotate(f"{label}\n{y:.3f}%", (tau, y), xytext=(-8 if last else (30 if tau == 0.9 else 8), -36 if tau == 0.9 else -8), textcoords="offset points",
                    ha="right" if last else "left", va="top", fontsize=8, color=ink, zorder=4,
                    bbox=dict(boxstyle="round,pad=0.2", fc=surface, ec="none", alpha=0.9))

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(0.2, 60000)
    ax.set_ylim(0.01, 20)
    ax.set_xticks([tau for _, tau in DESIGNS], ["0.3 s", "0.9 s", "2 s", "12 s", "1 min", "1 h", "8 h"])
    ax.xaxis.set_minor_locator(matplotlib.ticker.NullLocator())
    ax.set_yticks([0.01, 0.1, 1, 10])
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}%"))
    ax.set_xlabel("Liquidation latency τ (log scale)", color=ink2)
    ax.set_ylabel("Required maintenance margin z·σ·√(τ/YEAR) (log scale)", color=ink2)
    ax.set_title("Faster risk refresh ⇒ less margin: mmr ∝ √τ  (z = 3)", loc="left", color=ink, fontsize=13)
    ax.grid(True, which="major", axis="y", color=grid, lw=0.8)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(grid)
    ax.tick_params(colors=ink2, labelsize=9)
    ax.legend(loc="upper left", frameon=False, fontsize=9, labelcolor=ink2)

    fig.text(0.01, 0.01, "\n".join(_wrap(CAVEAT, 150)) + "\nSource: MATH_SPEC §3.4, bench/sqrt_tau.py. Markers: σ = 100%.",
             fontsize=7.5, color=ink2, va="bottom", ha="left")
    fig.subplots_adjust(left=0.1, right=0.93, top=0.92, bottom=0.24)
    path = OUT / "sqrt_tau.png"
    fig.savefig(path, facecolor=surface)
    return path


def _wrap(text: str, width: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        if len(cur) + len(word) + 1 > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    return lines + [cur]


def main() -> int:
    errors = check()
    if errors:
        print("MATH_SPEC §3.4 mismatch:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1
    print_table()
    print(f"\nwrote {write_csv()}")
    if "--no-plot" not in sys.argv:
        print(f"wrote {plot()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
