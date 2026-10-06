// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MeridianTypes — shared constants, enums and structs (FROZEN, see docs/INTERFACES.md)
/// @notice Units convention (normative, see docs/MATH_SPEC.md §0):
///  - "Wad"   suffix / WAD scale = 1e18 fixed point.
///  - Prices  : quote (AUSD) per 1 base unit, WAD.
///  - Sizes   : base units, WAD. Signed (int256) for positions: +long / -short.
///  - Quote amounts inside the protocol ("collateral", "notional", "pnl", "fee"): WAD.
///  - Token amounts crossing a token boundary ("amountToken"): native token decimals (AUSD = 6).
///  - Rates   : per-second fractions, WAD (e.g. 1e18 = 100%/s).
///  - Block time: milliseconds.
library MeridianConstants {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @dev AUSD on Monad mainnet has 6 decimals (verified onchain 2026-09-29). WAD / 1e6.
    uint256 internal constant AUSD_DECIMALS = 6;
    uint256 internal constant AUSD_TO_WAD = 1e12;
    /// @dev Upper bounds for any loop in the protocol (no unbounded loops).
    uint256 internal constant MAX_FILLS_PER_ORDER = 32;
    uint256 internal constant MAX_OPEN_ORDERS_PER_ACCOUNT = 64;
    uint256 internal constant MAX_BATCH = 32;
    /// @dev Funding-rate oracle ring buffer (IFundingRateOracle): 1 checkpoint / 200 blocks (~60 s), 1440 slots (~24 h).
    uint256 internal constant CHECKPOINT_BLOCKS = 200;
    uint256 internal constant CHECKPOINT_SLOTS = 1440;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    /// @dev Funding-swap order books quote price = 1 + fixed APR (WAD). APR = price - SWAP_PRICE_OFFSET.
    uint256 internal constant SWAP_PRICE_OFFSET = 1e18;
}

/// @notice Risk parameters for one isolated-margin market. All WAD unless stated.
struct RiskParams {
    uint256 imr; // initial margin ratio, e.g. 0.10e18 (10x)
    uint256 mmr; // maintenance margin ratio, e.g. 0.05e18
    uint256 takerFee; // fraction of notional, e.g. 0.0005e18 (5 bps)
    int256 makerFee; // fraction of notional; negative = rebate, e.g. -0.0001e18
    uint256 liqPenalty; // fraction of liquidated notional charged to liquidatee, e.g. 0.01e18
    uint256 keeperShare; // fraction of the penalty paid to the liquidator, e.g. 0.5e18
    uint256 maxOpenInterest; // per side, base units WAD (launch cap)
    uint256 maxPositionSize; // per account, base units WAD (launch cap)
}

/// @notice Funding parameters for one market. See docs/MATH_SPEC.md §1.
struct FundingParams {
    uint256 alpha; // EMA weight per block, WAD, e.g. 0.01e18
    int256 interestRate; // per-second WAD, added to the smoothed premium. Default 10.95% APR (0.01%/8h convention)
    uint256 rateCap; // |rate| <= rateCap, per-second WAD
    uint256 maxRateChangePerBlock; // |rate_b - rate_{b-1}| <= delta * blocksElapsed, per-second WAD
    uint256 blockTimeMs; // nominal block time used for dt (Monad mainnet: 300 ms since MIP-12). tunable
    uint256 premiumBandWad; // |premium| sample clamp before EMA, WAD, e.g. 0.05e18
}

/// @notice Cumulative funding state for one market. Updated at most once per block.
struct FundingState {
    int256 cumFunding; // F: cumulative funding per 1 base unit, quote WAD. Longs pay when rising.
    int256 cumIndexTime; // G: cumulative index * seconds per 1 base unit (WAD). Fixed legs of funding swaps accrue on G.
    int256 emaPremium; // p-bar, WAD
    int256 rate; // current rate, per-second WAD
    uint64 lastUpdateBlock; // block.number of last update
}

/// @notice Isolated-margin position of one account in one market.
struct Position {
    int256 size; // base WAD, +long / -short
    int256 openNotional; // signed quote WAD = sum(size_i * price_i) of the open lots; entry = openNotional / size
    int256 lastCumFunding; // F at last settlement
}

/// @notice Read model for UIs, keepers and the vault. Computed at current mark.
struct AccountView {
    uint256 collateral; // quote WAD, after settled funding & realized pnl
    int256 size; // base WAD
    uint256 entryPrice; // WAD, 0 if flat
    int256 unrealizedPnl; // quote WAD at mark
    int256 pendingFunding; // quote WAD the account OWES (+) or is OWED (-), not yet settled
    int256 equity; // collateral + unrealizedPnl - pendingFunding
    uint256 initialMargin; // |size| * mark * imr + reserved order margin
    uint256 maintenanceMargin; // |size| * mark * mmr
    uint256 reservedOrderMargin; // margin locked by resting orders
    uint256 liquidationPrice; // WAD, 0 if flat / not computable
    bool liquidatable;
}

/// @notice Vault configuration. See docs/MATH_SPEC.md §5.
struct VaultParams {
    uint256 leverage; // L, WAD (e.g. 2e18)
    uint256 driftBand; // theta: rebalance if |delta|/N > theta, WAD
    uint256 targetMarginRatio; // equity / notional target on the perp leg, WAD
    uint256 minMarginRatio; // rebalance if below, WAD
    uint256 exitHorizonSec; // h: horizon used in the exit-hedge test, seconds
    uint256 roundTripFee; // fee fraction per leg used in the exit test, WAD
    uint256 maxSlippage; // max slippage per spot/perp leg, WAD
    uint256 idleBuffer; // fraction of NAV kept idle for withdrawals, WAD
    uint256 depositCap; // max totalAssets, token units (AUSD 6 dp)
    uint256 skewCapacity; // vault short <= skewCapacity * max(0, other longs - other shorts), WAD (default 0.8e18)
    uint256 entryHorizonSec; // hedge only if avgFundingRate * entryHorizon > 2 * roundTripFee (default 7 days)
    uint256 maxSliceAssets; // max AUSD (6 dp) moved through the spot leg per rebalance (default 2_500e6)
}

/// @notice Vault hedge snapshot for UI / keepers / indexer.
struct HedgeState {
    uint256 spotBase; // base held (WAD)
    int256 perpSize; // vault perp size (WAD, negative when hedged)
    int256 perpEquity; // quote WAD
    uint256 idleAssets; // AUSD token units
    uint256 nav; // AUSD token units == totalAssets()
    int256 netDelta; // spotBase + perpSize, base WAD
    uint256 marginRatio; // perp equity / perp notional, WAD
    bool hedged;
    uint64 lastRebalanceBlock;
}

/// @notice Funding-swap market parameters. See docs/MATH_SPEC.md §6. All WAD unless stated.
struct SwapParams {
    uint256 aprMoveBuffer; // implied-APR shock covered by margin, e.g. 0.05e18 (5 APR points). PRICE_SHOCK (0.3) is a lib constant
    uint256 liqHorizonSec; // worst-case funding horizon covered by maintenance margin, e.g. 86_400
    uint256 imMultiplier; // IM = MM * imMultiplier, e.g. 1.5e18
    uint256 takerFeeApr; // fee = |size| * index * takerFeeApr * timeLeft / year, e.g. 0.002e18 (0.2% APR)
    int256 makerFeeApr; // negative = rebate
    uint256 liqPenalty; // fraction of MM charged on liquidation, e.g. 0.2e18
    uint256 keeperShare; // share of penalty to liquidator, e.g. 0.5e18
    uint256 maxOpenInterest; // per side, base units WAD
    uint256 maxPositionSize; // per account, base units WAD
}

/// @notice Fixed-for-floating funding swap position. Long = receive floating funding, pay fixed.
struct SwapPosition {
    int256 size; // base WAD (+ long / - short), notional = |size| * index
    int256 fixedAprNotional; // K: += sizeDelta * apr on EVERY fill, never reduced proportionally (MATH_SPEC §6.2);
    // avg fixed APR = K / size when size != 0; K != 0 with size == 0 is a locked spread stream
    int256 lastCumFunding; // perp F at last settlement
    int256 lastCumIndexTime; // perp G at last settlement
}

/// @notice Read model for a swap account at the current implied-APR mark.
struct SwapAccountView {
    uint256 collateral; // quote WAD
    int256 size;
    int256 avgFixedApr; // WAD
    int256 accruedNet; // unsettled floating - fixed since last settlement, quote WAD (+ = owed to account)
    int256 unrealizedPnl; // V = index * timeLeft * (size * markApr - K) / year, quote WAD (MATH_SPEC §6.3)
    int256 equity;
    uint256 initialMargin;
    uint256 maintenanceMargin;
    uint256 reservedOrderMargin;
    bool liquidatable;
}
