# Funding swaps on Perpl's funding rate (testnet)

**Status: live on Monad testnet (10143) since block 70,443,746 (12 Oct 2026). Testnet only.** A second `FundingSwapMarket` settles on **Perpl's** MON-perp funding instead of Meridian's. Someone long MON on Perpl can go long this swap on Meridian and lock their Perpl funding cost at a fixed APR. Nothing else onchain did this before: the first swap market (`0xACFc…Fe33`) settles on Meridian's own ClearingHouse, and `MeridianMfiFeed` only stores APR snapshots.

`FundingSwapMarket` is **unchanged**. It reads its floating leg through seven views on the address it was deployed with (`perpClearingHouse_`). One new contract, `PerplFundingSource`, answers those views from snapshots of Perpl's exchange (CR-017, `interfaces-v1.9`, MATH_SPEC §6.8).

## Live (testnet 10143)

| | Address | Deploy tx |
|---|---|---|
| `PerplFundingSource` (Perpl perp 64 = MON) | `0xC008aF47fCC651889a1d66f0734da941A55224cC` | `0x2771a46fa54716fffc61203fa8176a50bd337261ab88492f581d656c028a80bc` |
| `FundingSwapMarket` `MON-FUNDING-PERPL` | `0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde` | `0x00526700a979578e75ffe89ad10e81f492241b98c09cf35ba09820412c32d60c` |
| Swap `OrderBook` (tick 1 bp APR, lot 1,000 MON) | `0x5D4f03B6Afa525ed580C75878A2F51A35c202334` | `0xf7f28be80123a0761cf935693214cd3e35cc12f10f359d34821e6dc035776666` |
| `poke()` (first, no-op) | | `0x33b5f40df66983af23cf5c2868c4c3a97c0a4b9b3d910ac47f4fedd74efe87e3` |
| `setOrderBook` | | `0x2b55b372e27c34300d96ecfafe3196701c2a34d46b514169f8c56f8c37a63c8a` |
| InsuranceFund `setMarketAuthorized(fs, true)` | `0xCcd97285dD2fca8D028D880Ed754039118437b48` | `0xefdb50459819542c946aa513a29d5964f7261cee102271fddf1f0a3a64062a3e` |
| Perpl Exchange (read, ERC-1967 proxy) | `0x1964c32f0be608e7d29302aff5e61268e72080cc` | `deployments/perpl.json` |

Maturity 1,794,414,069 (unix s, 30 days after listing). Collateral tAUSD, InsuranceFund and owner are the existing ones (`deployments/10143.json`). The record is `swapMarkets[0]`; the broadcast is `contracts/broadcast/AddSwapMarket.s.sol/10143/run-latest.json`. `VerifyDeployment` passes 15/15 checks for it.

## Units

Verified 12 Oct 2026 on testnet perp 64 (priceDecimals 5, fundingSumScalingExp 3, interval 8,571 blocks / 2,580 s, clamp 10 per 100k per interval). Script: `tools/perpl-swaps/phase0_units.py` (read-only, public archive RPC). Output: `docs/outputs/ps_phase0_perpl_units_10143.json`.

**Result over 24 consecutive live funding events:** `Δ fundingSumPNS = fundingPaymentPNS` 24/24, event sum = `getFundingSumAtBlock` view 24/24, `fundingPaymentPNS = trunc0(rate · fundingPricePNS · 10³ / 1e5)` 24/24. `F_wad = fundingSumPNS · 10^(18 − 5 − 3) = sum · 1e10`, and `|ΔF − rate · P_wad / 1e5| < 1e10` (one sum unit, Perpl's own truncation toward zero). Rates seen: +4 … −3.

| feb | emitted (block) | lead | rate /1e5 | fundingPricePNS | oracle@B−1 | mark@B−1 | Δsum | ppl | Δsum = ppl | ppl = trunc0(r·P·10³/1e5) | ΔF (WAD) | r·P_wad/1e5 (WAD) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|---:|---:|
| 70,239,345 | 70,239,267 | 78 | 2 | 2780 | 2779 | 2781 | 55 | 55 | ✅ | ✅ | 550,000,000,000 | 556,000,000,000 |
| 70,247,916 | 70,247,838 | 78 | 4 | 2759 | 2760 | 2763 | 110 | 110 | ✅ | ✅ | 1,100,000,000,000 | 1,103,600,000,000 |
| 70,256,487 | 70,256,409 | 78 | 4 | 2726 | 2726 | 2726 | 109 | 109 | ✅ | ✅ | 1,090,000,000,000 | 1,090,400,000,000 |
| 70,265,058 | 70,264,980 | 78 | 4 | 2698 | 2698 | 2700 | 107 | 107 | ✅ | ✅ | 1,070,000,000,000 | 1,079,200,000,000 |
| 70,273,629 | 70,273,551 | 78 | 0 | 2710 | 2709 | 2711 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,282,200 | 70,282,122 | 78 | 2 | 2697 | 2696 | 2697 | 53 | 53 | ✅ | ✅ | 530,000,000,000 | 539,400,000,000 |
| 70,290,771 | 70,290,693 | 78 | 2 | 2679 | 2681 | 2680 | 53 | 53 | ✅ | ✅ | 530,000,000,000 | 535,800,000,000 |
| 70,299,342 | 70,299,265 | 77 | 2 | 2655 | 2655 | 2655 | 53 | 53 | ✅ | ✅ | 530,000,000,000 | 531,000,000,000 |
| 70,307,913 | 70,307,836 | 77 | 1 | 2680 | 2680 | 2680 | 26 | 26 | ✅ | ✅ | 260,000,000,000 | 268,000,000,000 |
| 70,316,484 | 70,316,406 | 78 | -1 | 2650 | 2651 | 2649 | -26 | -26 | ✅ | ✅ | -260,000,000,000 | -265,000,000,000 |
| 70,325,055 | 70,324,977 | 78 | 1 | 2614 | 2614 | 2615 | 26 | 26 | ✅ | ✅ | 260,000,000,000 | 261,400,000,000 |
| 70,333,626 | 70,333,548 | 78 | 0 | 2610 | 2608 | 2610 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,342,197 | 70,342,119 | 78 | 0 | 2617 | 2619 | 2618 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,350,768 | 70,350,690 | 78 | 2 | 2608 | 2608 | 2610 | 52 | 52 | ✅ | ✅ | 520,000,000,000 | 521,600,000,000 |
| 70,359,339 | 70,359,261 | 78 | 0 | 2588 | 2588 | 2588 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,367,910 | 70,367,832 | 78 | 0 | 2584 | 2584 | 2585 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,376,481 | 70,376,403 | 78 | 0 | 2583 | 2584 | 2583 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,385,052 | 70,384,975 | 77 | 0 | 2565 | 2564 | 2565 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,393,623 | 70,393,545 | 78 | 0 | 2565 | 2563 | 2564 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,402,194 | 70,402,116 | 78 | 0 | 2573 | 2573 | 2571 | 0 | 0 | ✅ | ✅ | 0 | 0 |
| 70,410,765 | 70,410,687 | 78 | -3 | 2581 | 2583 | 2580 | -77 | -77 | ✅ | ✅ | -770,000,000,000 | -774,300,000,000 |
| 70,419,336 | 70,419,258 | 78 | -3 | 2570 | 2572 | 2572 | -77 | -77 | ✅ | ✅ | -770,000,000,000 | -771,000,000,000 |
| 70,427,907 | 70,427,829 | 78 | -1 | 2563 | 2565 | 2564 | -25 | -25 | ✅ | ✅ | -250,000,000,000 | -256,300,000,000 |
| 70,436,478 | 70,436,400 | 78 | -1 | 2529 | 2529 | 2530 | -25 | -25 | ✅ | ✅ | -250,000,000,000 | -252,900,000,000 |

**Sign: the sum rises when longs pay.** Proven on real positions, not only from docs: across feb 70,436,478 (rate −1, Δsum −25), every one of 30 perp-64 positions read with `getPositionsV2` at feb − 1 and feb moved `premiumPnlCNS` by `−side · lots · ΔF`: e.g. account 9, long 43,066 MON, +10,766 CNS (= 43,066 · 25e-8 AUSD, floored); account 242, short 300 MON, −75 CNS. Across feb 70,419,336 (rate −3, Δsum −77) account 9 moved +33,161 CNS. So longs receive when the sum falls, and `F_wad = sum · 1e10` has Meridian's convention ("F rises ⇒ longs pay", MATH_SPEC §1.2) without a sign flip. Perpl pays positions exactly `Δsum`, so the swap's floating leg equals what a Perpl position is credited, up to rounding. Script: `tools/perpl-swaps/phase0_sign.py`.

**Price.** `fundingPricePNS` matches neither the mark nor the oracle exactly: oracle@B−1 10/24, mark@B−1 8/24, and it is always within ±7.8 bps of the oracle at the emitting block. It is an argument of Perpl's funding-keeper transaction (`setFundingSum(…, pricePNS, …)` in a batch). The adapter therefore uses Perpl's **oracle** price at the poke for G. The floating leg is unaffected, because it uses Perpl's sum directly. The fixed leg's notional differs from Perpl's funding notional by this basis (≤ 8 bps seen, plus the price move between the event and the poke).

**Boundary.** The funding event is emitted **77–78 blocks before** its `feb`. `getFundingSumAtBlock(64, b)` returns it only for `b ≥ feb`. At the emitting block and at `feb − 1` the view still returns the previous event (24/24). From the emitting block on, `fundingRatePct100k` in `getPerpetualInfoV2` already shows that event's rate (24/24). So the next rate is public about 23 s before it applies (see Risks).

**History.** `getFundingSumAtBlock(64, b)` called at head answers for past `b` at least 30 days back (1 d: sum −22,291 at feb 70,145,064; 7 d: −20,321 at 68,413,722; 30 d: −39,074 at 61,796,910). The adapter doesn't rely on this: it snapshots at the head.

**Gas** (`eth_estimateGas`, incl. 21k intrinsic): `getFundingSumAtBlock` 59,710 (same at head and 96,000 blocks back), `getPerpetualInfoV2` 55,378.

## Design

`contracts/src/oracle/PerplFundingSource.sol`: non-upgradeable, no owner. Immutables `exchange`, `perpId`, interval (blocks read from Perpl, seconds from `deployments/perpl.json`), `sumScale`, `priceScale`.

- **Snapshot at poke.** `poke()` is permissionless and `nonReentrant`. It reads `(fundingSumPNS, fundingEventBlock)` at the head. If `feb` has not advanced, it returns `false` and writes nothing. Otherwise it reads `getPerpetualInfoV2` and stores one observation `{F, G, feb}` plus the price, Perpl's current rate and cap. The constructor writes the first observation (G = 0), so a swap never reads an empty source.
- **Both legs step together.** `ΔG = I · Δfeb · intervalSec / intervalBlocks` is written only in the poke that advances F. This is O(1) however many events were missed. Perpl pays funding in one lump per interval. A fixed leg accruing every block would let a trader enter seconds before the lump and collect a whole interval of floating for almost no fixed cost. Here, a trader in for an interval pays the interval's fixed leg, and a trader in for no event pays nothing and receives nothing.
- **Never extrapolated, never rewritten.** Views answer from storage only: a swap touch costs SLOADs, not a call into Perpl. G never decreases, and an observation never changes once written.
- **Stale price ⇒ pause.** `oraclePNS == 0` or `oracleTimestampSec` older than `MAX_PRICE_AGE = 120 s` makes `poke()` revert `StalePerplPrice`, so F and G pause together (MATH_SPEC §1.6 behaviour). Nothing is lost: the next successful poke steps F and G across the whole gap.
- **Unit guard.** If Perpl changes `priceDecimals` or `fundingSumScalingExp` (admin `setFundingSumScalingExp`), `poke()` reverts `PerplScaleChanged` and the market stops accruing until a new source is deployed.
- **Views.** `latestObservation` returns the last snapshot, with the observation block = Perpl's feb. `observe` and `averageFundingRate` read a 256-entry ring (one entry per poke, about 7.6 days), with a binary search bounded at 8 steps and `ObservationTooOld` below the ring. Until 8 h of snapshots exist, the swap's mark falls back to `fundingState().rate · YEAR` (its `try/catch`). `averageFundingRate` is clamped to ±`rateCap`; that only binds if Perpl's funding price strays more than 5% from its oracle or Perpl's admin overwrote a sum. `fundingState()` = (F, G, 0, Perpl's rate per second, feb). `fundingParams()`: only `rateCap` (Perpl's clamp per second with a 5% price buffer, rounded up) and `blockTimeMs` (= 2,580,000 / 8,571 = 301); every other field is 0. `indexPrice()` = Perpl's oracle price at the last poke.

**Hedge semantics.** A swap **long** receives `q·ΔF`, which is what a Perpl long of size q pays, and pays `K·ΔG/YEAR` at its fixed APR. Perpl long + swap long = the fixed leg only, to rounding. The fork test checks this identity on a real event: `netLong + perplLongReceives = −fixed` within 1 wei.

**Margin.** The swap's margin uses `capApr = rateCap · YEAR`. Perpl's clamp (10 per 100k per interval) is ±122% APR, or 128% with the buffer, against 1,752% on the Meridian market, so requirements are much lower. Live, for 10,000 MON long at 10% with I = 0.02541 and τ ≈ 30 d: MM 2.63 AUSD (1.04% of notional), IM 3.95 AUSD (1.55%). If Perpl raises its clamp, the cap follows at the next poke.

## Trust assumptions and risks (also stated in the app)

- **This market trusts Perpl.** Perpl's admin can overwrite a funding sum (`setFundingSum(…, allowOverwrite, …)`), and the exchange is an upgradeable ERC-1967 proxy. A bad sum becomes this market's floating leg. Observations already written never change, but the next poke takes whatever Perpl reports. The average is clamped to the cap; settlement is not.
- **The next rate is public before it applies** (≈ 78 blocks / 23 s, plus `fundingRatePct100k`). Anyone can trade the swap on that information before the poke. It is a transfer between counterparties, not a protocol loss. The MM must price the known next interval in, and the keeper must poke promptly. The fixed and floating legs step only at the poke, so a position opened after the event applied but before the poke receives that event's floating leg and pays its fixed leg in full. This is the same window Perpl's own traders have.
- **If nobody pokes, accrual on this market pauses.** It is not lost: the next poke catches up. But marks, margins and the realized APR are as of the last poke. `VerifyDeployment` and the keeper's `/health` report the lag; the keeper pokes within seconds of each event.
- **The index is the oracle price at the last poke** (≤ 43 min old with a running keeper). Margin and fees use it. A MON move between pokes shifts margin by that move times the stream's value. That is small next to the ≈ 0.5% IM–MM gap here, but nonzero.
- **Price basis.** The fixed leg is priced at Perpl's oracle at the poke; Perpl prices funding at a keeper-supplied price (≤ 8 bps apart in 24 events).

## Known limits

- One maturity per market, no roll (as for the Meridian swap market).
- Testnet MON only (perp 64). Mainnet Perpl MON is perp 10 with different decimals (priceDecimals 6, exp 2 ⇒ `sumScale` 1e10 again). Not deployed there (out of scope).
- No vault earns Perpl funding (out of scope).
- `getFundingInterval()` is `pure` in Perpl's ABI; the interface declares it `view` so a mock can script it (same selector).

## Tests and gas

| Suite | Count | |
|---|---:|---|
| `test/unit/PerplFundingSource.t.sol` | 34 | every external function and revert path, no-op poke, event-before-feb, multi-event catch-up, partial gap, ring wrap, `ObservationTooOld`, cap clamp |
| `test/fuzz/PerplFundingSource.fuzz.t.sol` | 4 × 1,000 runs | scale exact over int48 and decimals 0–8; rate rounds toward 0, cap rounds up; G steps ⌊I·Δfeb·IS/IB⌋ and never decreases; average within the cap and unclamped for any rate inside Perpl's clamp |
| `test/invariant/PerplSwapInvariants.t.sol` (+ `PerplSwapHandler`) | 3 | Σq = 0, ΣK = 0, OI; solvent (balance ≥ Σ(C + pending accrual) + fees); G monotone; F = Perpl sum × 1e10 after each poke |
| `test/fork/PerplSwap.fork.t.sol` (archive RPC, pinned blocks) | 3 | adapter reproduces the §Units numbers; a real FundingSwapMarket long/short across feb 70,427,907: each side within 1 wei of `q·ΔF − K·ΔG/YEAR`, dust 1 wei, hedge identity; gas |
| `keepers/ts-fallback/test/perplsource.test.ts` | 11 | poke decision with recorded views, back-off, record resolution |

Full `forge test`: 615 passed, 0 failed, 9 skipped (fork suites without an RPC).

Gas (fork of 10143 against the real exchange, `--isolate`, Cancun schedule, incl. 21k intrinsic): `poke` advancing **125,735**, `poke` no-op **45,565**; swap `settle` with a position on this market **89,714** vs **131,308** on the live Meridian swap market at the same block (account with K ≠ 0). On testnet the poke estimated 131,925 (limit 158,310 = ×1.2), each settle about 109.6k.

## Smoke on testnet (labelled test wallets)

Long = ETH_VICTIM test account `0xe7D7…dB08` (taker), short = demo-MM operator `0xB1a7…5bd1` (maker). 10 lots = 10,000 MON at 10.00% APR. The deployer pokes. Logs: `docs/outputs/ps_perpl_swap_smoke_*_10143.log`; scripts `tools/perpl-swaps/smoke-{open,settle}.sh`.

| Step | Tx | Block |
|---|---|---:|
| 0.4 MON deployer → long (gas) | `0x635ccf11d3de6b0bf21b7967d64ddf8c8d7f7505d13850332fe940bea5ff9a1b` | 70,444,011 |
| long: mint 1,000 tAUSD | `0xeecb47d6fe33c8906e54ed20bb55ac0a17eab1a001766d988d01276429247005` | 70,444,023 |
| long: approve | `0x54574dac7b13b70931b6d4cc12d5cf6d88c31cfe7f6f6d1e612809d6ce7124f0` | 70,444,029 |
| long: deposit 1,000 tAUSD | `0x2150191fb3912e65bc8833f0e6f5766ac2b961bf1d722a2af3e92a61eaf0aa60` | 70,444,041 |
| short: mint 1,000 tAUSD | `0xb2a1035b6295b714779be80fdfa535636f9ddd02323261393a16f79824cd4eb2` | 70,444,055 |
| short: approve | `0x3830f7103a7e910ca0baa4617609d723d443a397483f365d125e038478bf273b` | 70,444,068 |
| short: deposit 1,000 tAUSD | `0xbdbea6396bb8259d7ac8824fe148eabfa92f6690508135d76bdb5a36e47cd0d1` | 70,444,079 |
| short rests ask 10 lots @ 10.00% | `0x28d00b6b6b94d389d7bd8ce28b8fa8f36c41fa06174267b5229dbc727507060f` | 70,444,085 |
| long takes 10 lots | `0x8264e7305e0fbb8e61e76dba6403f60a63348da1b17dc45446c7774e521465f1` | 70,444,097 |
| Perpl event feb 70,445,049 applies; `poke()` | `0x3d150585fa0e1f4e992e071f2bbb84b729dcae4e9cb5ad309e443ffaa6eb31d4` | 70,445,110 |
| `settle(long)` | `0x86d50061a93ad3af901d57ee0e582dae2e0438e8c874fcb7d950a11f61773a7d` | 70,445,120 |
| `settle(short)` | `0xb6fa8a915683d75141df4b8bdaef1b98043ba978972bbf12b83884bf43c657e4` | 70,445,133 |

Checked by hand (`smoke-settle.sh`). The source went from (F −214,250,000,000,000, G 0, feb 70,436,478) to (F unchanged, G 65,557,800,000,000,000,000, feb 70,445,049): Perpl's rate for that interval was **0**, so ΔF = 0, and ΔG = I · 2,580 s with I = 0.02541. Expected net = ⌊(q·ΔF·YEAR − K·ΔG)/(1e18·YEAR)⌋ = long −2,078,824,200,913,243 wei, short +2,078,824,200,913,242 wei. Observed: exactly the same, dust 1 wei. In AUSD, the long paid 0.002079 of fixed (10% APR on $254 for 43 min) and the short received it. The floating leg of this event was zero, so the same positions were settled again across the next event:

| Step | Tx | Block |
|---|---|---|
| Perpl event feb 70,453,620 (rate −1 per 100k) applies; `poke()` | `0x8a7e13a9a38185ea420ff93a1feb6e72bf0575276b06dfcb44c3cc9e2b51f844` | 70,453,694 |
| `settle(long)` | `0xa797b7061c5bd12eacd563585b8a7f7b65b777004c801d2d407365513bdfa3d1` | 70,453,709 |
| `settle(short)` | `0xd2e6390e70f834201cc1482b803f7456d3e607189d0248406ce649000659206a` | 70,453,715 |

ΔF = −250,000,000,000 (Perpl longs receive), ΔG = 64,577,400,000,000,000,000 (I = 0.02503 × 2,580 s). Floating (long) = q·ΔF = −0.0025 AUSD, fixed (long) = K·ΔG/YEAR = 0.002047736 AUSD. Expected net long −4,547,735,920,852,360 wei, short +4,547,735,920,852,359 wei; observed exactly the same, dust 1 wei (`docs/outputs/ps_perpl_swap_smoke_settle2_10143.log`). The swap long paid what a 10,000 MON Perpl long received (0.0025 AUSD) plus its 10% fixed leg: Perpl long + swap long = the fixed leg.

## Operations (testnet, from 12 Oct 2026 ~17:10 UTC)
- Keeper `pnpm perpl-swap` with the deployer key `0xEF4E…3b91`: pokes after each Perpl event, `/health` reports the lag.
- Swap MM `MARKET=swap SWAP_MARKET=perpl` with the demo-MM operator `0xB1a7…5bd1` (2 MON funded from the deployer, tx `0x9b6a0a864e23875e902dc456cca03f765ad92bf6fe5282f20e22582b4bb163cf`): 1 level × 1 lot, requote 1,000 APR bps, tick every 33 blocks. First quote at block 70,453,928, anchored to Perpl's current rate (−12.22% APR, no 8 h of snapshots yet): bid −12.25% / ask −12.20%. MON/h measured in `keepers/RUNBOOK.md` §7g.
