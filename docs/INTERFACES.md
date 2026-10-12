# INTERFACES — frozen cross-workstream contracts

**Frozen: `interfaces-v1.9` (12 Oct 2026, CR-001..007, CR-014, CR-016, CR-017).** The `.sol` files in `contracts/src/interfaces/` are the source of truth. The second half of this document is generated verbatim from them (`python3 tools/gen_interfaces_md.py`; CI runs `--check`). To change anything, file an entry in `docs/CHANGE_REQUESTS.md`.

## 1. Who implements / who calls

| Interface | Implemented by (WS, founder) | Called by | Mock |
|---|---|---|---|
| `MeridianTypes.sol` | WS-00 (A) | all | — |
| `IOrderBook` | OrderBook (WS-01, A), deployed twice: perp + swap | traders, MM bot, vault, app | `MockOrderBook` |
| `IMarginEngine` | ClearingHouse (WS-02, A), FundingSwapMarket (WS-05, A) | OrderBook hooks | `MockClearingHouse` |
| `IClearingHouse` (+ IMarginEngine, IFundingRateOracle) | ClearingHouse (WS-02, A) | OB, vault, keeper, swap market, app | `MockClearingHouse` (`mockAccrue`) |
| `IFundingRateOracle` | ClearingHouse (WS-02, A) | swap market, vault entry/exit rule, app, 3rd parties | `MockClearingHouse` |
| `IFundingSwapMarket` | FundingSwapMarket (WS-05, A) | swap OB hooks, keeper (liquidations, settleMaturity), app | — (builds on `MockClearingHouse`) |
| `IOracleAdapter` | PythChainlinkOracleAdapter (WS-03, B) | CH, keeper, MM bot | `MockOracleAdapter` |
| `IInsuranceFund` | InsuranceFund (WS-02, A) | CH, swap market | `MockInsuranceFund` |
| `IMarketFactory` | MarketFactory (WS-02, A) | deploy script, indexer, app | — |
| `IMeridianVault` | MeridianVault (WS-04, B) | users/app, keeper | `MockMeridianVault` |
| `IKuruHedger` | KuruHedger (WS-04, B) | vault | `MockKuruHedger` |
| `IMeridianKeeperReceiver` | MeridianKeeperReceiver (K4, `automation/`) | CRE KeystoneForwarder (simulation: MockKeystoneForwarder) | — |
| `IMeridianMfiFeed` (CR-016) | MeridianMfiFeed (K4, `oracle/`), written by the receiver's action 6 | any contract (`latest()`), app | — |
| `IPerplFundingSource` (CR-017, + IFundingRateOracle) | PerplFundingSource (WS-05, `oracle/`) | a second FundingSwapMarket (as its `perpClearingHouse`), keeper (`poke`), indexer, app | `MockPerplExchange` (scripts Perpl) |
| `external/*` | Kuru / Pyth / Chainlink / Perpl (`IPerplExchange`, CR-017) | adapters | `MockKuruHedger`, `MockAggregatorV3`, `MockPerplExchange` |
| `deferred/*` (PT/YT) | not built in the hackathon | — | — |

## 2. Cross-module rules (normative)
1. **Units:** see `MeridianTypes.sol` header and MATH_SPEC §0. `*Token` params = AUSD 6 dp; `*Wad` = 1e18.
2. **OrderBook ⇄ IMarginEngine protocol** (perp ClearingHouse and FundingSwapMarket alike):
   - Before an order rests: `reserveOrderMargin` (may revert ⇒ whole placement reverts).
   - On cancel / eviction / fill: `releaseOrderMargin` for the cancelled/evicted remainder; `settleMakerFill` releases the filled part itself.
   - Per maker fill: `settleMakerFill` returns `MakerFillResult` (CR-007, `interfaces-v1.6`):
     - `Filled` ⇒ settled (the engine released the filled part of the reservation).
     - `Evict` ⇒ the maker itself can't carry the fill (margin, position cap; swap: also `Matured`, permanent): the book evicts that order (`OrderEvicted`, remainder released) and continues matching.
     - `Skip` ⇒ the market refuses new risk right now (perp: paused or oracle stale; swap: paused). Nothing is written for the fill and the reservation is kept; the book leaves the order exactly as it is (lots, FIFO position, level totals, bitmap), emits `MakerFillSkipped`, and **stops matching** (no further orders or levels: jumping past the head would break price-time priority). Fills already made in this taker order settle normally; `lastTrade` moves only if something filled; a crossing remainder never rests (bestBid < bestAsk). A Skip counts as a visit toward `MAX_FILLS_PER_ORDER`.
     - The perp checks pause and staleness before margin, so a maker that is both under-margined and hits a paused / stale market is Skipped (it stays; conservative). The maker's funding (perp) / accrual (swap) settlement is written on Skip and Evict alike.
     - Consequence while stale or paused: a reduce-only (or any reducing) taker fills only against makers that are themselves reducing, up to the first increasing maker at the head, then stops. Liquidations don't use the book and are unaffected.
   - Once per taker order (if filled > 0): `settleTakerFill(Σsize, Σnotional)` last, after all maker fills. It reverts on IM failure / reduce-only violation.
   - Both hooks are `onlyOrderBook`. The CH trusts the book for prices; the book trusts the CH for margin.
3. **Funding touch:** every mutating CH function starts with the internal funding touch; `updateFunding()` is the public poke.
4. **Vault as a trader:** the vault is a normal account in CH/OB (`msg.sender = vault`). No privileged path.
5. **Events** are the indexer's only data source (WS-06 must not need view calls except for vault NAV bootstrapping).
6. **Order ids** are `uint64`, monotonically increasing per book, never reused. `orderId = 0` means "none".
7. **Ticks:** `price = tick · tickSize`. `bestBid() == 0` ⇒ no bids; `bestAsk() == type(uint32).max` ⇒ no asks.
8. **Signs:** `size > 0` long. `FundingSettled.payment > 0` ⇒ the account paid. `PositionChanged.fee < 0` ⇒ rebate.

## 3. Event → indexer entity map (for WS-06)
| Event | Entity |
|---|---|
| `IOrderBook.OrderPlaced / OrderCancelled / OrderEvicted` | `Order` (status) |
| `IOrderBook.MakerFillSkipped` | `MakerFillSkip` (the `Order` stays Open, unchanged) |
| `IOrderBook.Trade` | `Trade`, `Candle` (1m/1h), `MarketStats.volume` |
| `IClearingHouse.PositionChanged` | `Position`, `AccountMarket`, `MarketStats.fees` |
| `IClearingHouse.FundingUpdated` | `FundingTick` (per block, incl. cumIndexTime), `MarketStats.lastRate` |
| `IFundingRateOracle.FundingCheckpoint` | `FundingCheckpoint` (oracle history, APR windows) |
| `IFundingSwapMarket.SwapPositionChanged / SwapAccrualSettled / SwapLiquidated / MaturitySettled / Deposited / Withdrawn` | `SwapPosition`, `SwapTrade`, `SwapStats` |
| `IClearingHouse.FundingSettled` | `AccountMarket.fundingPaid` |
| `IClearingHouse.Liquidated / BadDebtSocialized` | `Liquidation` |
| `IClearingHouse.Deposited / Withdrawn` | `AccountMarket.collateral` |
| `IMeridianVault.Deposit / Withdraw` (ERC-4626) , `NavSnapshot`, `Rebalanced` | `VaultSnapshot`, `VaultUser` |

## 4. Verbatim interface sources

<!-- BEGIN GENERATED: do not edit below; run tools/gen_interfaces_md.py -->

### `contracts/src/interfaces/MeridianTypes.sol`

```solidity
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
```

### `contracts/src/interfaces/IOrderBook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOrderBook — one fully onchain CLOB per perp market (FROZEN)
/// @notice Price-time priority. Price = tick * tickSize (WAD). Size = lots * lotSize (base WAD).
///         Instrument-agnostic (CR-003): every fill settles synchronously in the market's IMarginEngine —
///         the perp ClearingHouse (price = AUSD per MON) or the FundingSwapMarket (price = 1 + fixed APR).
///         No offchain matching.
///         Loops are bounded by MeridianConstants.MAX_FILLS_PER_ORDER / MAX_BATCH.
interface IOrderBook {
    // ─── Flags for placeLimitOrder ─────────────────────────────────────────────
    // uint8 bitmask: FLAG_POST_ONLY = 1, FLAG_IOC = 2, FLAG_REDUCE_ONLY = 4

    struct OrderView {
        address maker;
        bool isBid;
        uint32 tick;
        uint64 remainingLots;
        uint64 placedBlock;
    }

    // ─── Events ────────────────────────────────────────────────────────────────
    event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags);
    event OrderCancelled(uint64 indexed orderId, address indexed maker, uint64 remainingLots);
    /// @notice Resting order removed during matching because the maker failed the margin check.
    event OrderEvicted(uint64 indexed orderId, address indexed maker, uint64 remainingLots);
    /// @notice The engine refused a fill on this resting order because the market refuses new risk (paused, oracle
    ///         stale; CR-007). The order is still live and unchanged; matching stopped at it.
    event MakerFillSkipped(uint64 indexed orderId, address indexed maker);
    /// @notice One event per maker fill. priceWad = tick * tickSize; sizeWad = lots * lotSize.
    event Trade(
        uint64 indexed makerOrderId,
        address indexed maker,
        address indexed taker,
        bool takerIsBid,
        uint32 tick,
        uint64 lots,
        uint256 priceWad,
        uint256 sizeWad
    );

    // ─── Errors ────────────────────────────────────────────────────────────────
    error InvalidTick();
    error InvalidSize();
    error PostOnlyWouldCross();
    error NotOrderOwner();
    error OrderNotFound();
    error TooManyOpenOrders();
    error NoLiquidity();
    error SlippageExceeded();
    error BatchTooLarge();
    error Paused();

    // ─── Trading ───────────────────────────────────────────────────────────────
    /// @return orderId 0 if nothing rests (fully filled or IOC)
    /// @return filledLots lots filled immediately as taker
    function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags)
        external
        returns (uint64 orderId, uint64 filledLots);

    /// @notice Market order = IOC limit at `limitTick` (worst acceptable price). Reverts SlippageExceeded
    ///         if filled < minFilledLots.
    function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly)
        external
        returns (uint64 filledLots, uint256 avgPriceWad);

    function cancelOrder(uint64 orderId) external;

    /// @dev length <= MAX_BATCH
    function cancelOrders(uint64[] calldata orderIds) external;

    /// @notice Cancel + place in one call (market-maker hot path; target < 100k gas). Loses time priority.
    function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags)
        external
        returns (uint64 newOrderId, uint64 filledLots);

    // ─── Views ─────────────────────────────────────────────────────────────────
    /// @notice The IMarginEngine this book settles into (name kept for compatibility).
    function clearingHouse() external view returns (address);
    function tickSize() external view returns (uint256); // WAD
    function lotSize() external view returns (uint256); // base WAD
    /// @return tick 0 if no bids
    function bestBid() external view returns (uint32 tick);
    /// @return tick type(uint32).max if no asks
    function bestAsk() external view returns (uint32 tick);
    /// @return midWad (bestBid+bestAsk)/2 price, WAD
    /// @return valid false if either side is empty
    function midPrice() external view returns (uint256 midWad, bool valid);
    /// @return priceWad last traded price, 0 if never traded
    /// @return blockNumber block of that trade
    function lastTrade() external view returns (uint256 priceWad, uint64 blockNumber);
    function getOrder(uint64 orderId) external view returns (OrderView memory);
    function getLevel(uint32 tick) external view returns (uint64 totalLots, uint32 orderCount);
    /// @notice Up to `maxLevels` (<= MAX_BATCH) best levels on one side.
    function getDepth(bool isBid, uint256 maxLevels) external view returns (uint32[] memory ticks, uint64[] memory lots);
    function openOrderCount(address account) external view returns (uint256);
}
```

### `contracts/src/interfaces/IMarginEngine.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMarginEngine — the hook surface an OrderBook settles against (FROZEN, CR-003)
/// @notice The OrderBook is instrument-agnostic: it matches prices/sizes and calls these hooks. Two engines
///         implement it: the perp ClearingHouse (price = asset price) and the FundingSwapMarket
///         (price = 1 + fixed APR). Protocol: docs/INTERFACES.md §2.
interface IMarginEngine {
    error OnlyOrderBook();
    error InsufficientMargin();
    error ReduceOnlyViolated();

    /// @notice Outcome of one maker fill (CR-007). Filled = settled. Evict = the maker itself can't carry the fill
    ///         (margin, position cap, matured swap): the book removes the order, releases its remainder and continues.
    ///         Skip = the market refuses new risk right now (paused, oracle stale): the order must stay untouched
    ///         and the book stops matching.
    enum MakerFillResult {
        Filled,
        Evict,
        Skip
    }

    /// @notice Reverts InsufficientMargin if the order would push initial margin above equity.
    function reserveOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    function releaseOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    /// @notice Settle one maker fill; on Filled, releases the matching reservation.
    /// @return result Filled => settled; Evict => the book must evict the order (release its remainder) and continue;
    ///         Skip => nothing written for the fill, reservation kept: the book must leave the order resting
    ///         untouched and stop matching.
    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        returns (MakerFillResult result);
    /// @notice Settle the aggregated taker side of one order. Enforces IM (or reduce-only) and reverts otherwise.
    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external;

    function orderBook() external view returns (address);
}
```

### `contracts/src/interfaces/IClearingHouse.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RiskParams, FundingParams, FundingState, Position, AccountView} from "./MeridianTypes.sol";
import {IMarginEngine} from "./IMarginEngine.sol";
import {IFundingRateOracle} from "./IFundingRateOracle.sol";

/// @title IClearingHouse — isolated-margin accounting for ONE perp market (FROZEN)
/// @notice One ClearingHouse per market keeps each market's state disjoint (Monad parallel execution).
///         Holds the market's AUSD collateral. Funding is O(1): a cumulative index F updated by the first
///         transaction touching the market in a block and settled lazily per account on touch.
/// @dev CR-003: OrderBook hooks moved to IMarginEngine; funding-rate oracle views in IFundingRateOracle.
interface IClearingHouse is IMarginEngine, IFundingRateOracle {
    // ─── Events ────────────────────────────────────────────────────────────────
    event Deposited(address indexed account, uint256 amountToken, uint256 amountWad);
    event Withdrawn(address indexed account, uint256 amountToken, uint256 amountWad);
    /// @notice Emitted once per block per market (first touch). Source of the funding-history chart.
    event FundingUpdated(
        uint64 indexed blockNumber,
        int256 premium,
        int256 emaPremium,
        int256 rate,
        int256 cumFunding,
        int256 cumIndexTime,
        uint256 indexPriceWad,
        uint256 markPriceWad
    );
    /// @param payment quote WAD paid by the account (+) or received (-)
    event FundingSettled(address indexed account, int256 payment, int256 cumFunding);
    /// @notice Emitted for every fill on both maker and taker side, and for liquidation transfers.
    event PositionChanged(
        address indexed account,
        int256 sizeDelta,
        int256 newSize,
        uint256 priceWad,
        int256 realizedPnl,
        int256 fee,
        bool isMaker
    );
    event Liquidated(
        address indexed account,
        address indexed liquidator,
        int256 sizeTransferred,
        uint256 markPriceWad,
        uint256 penalty,
        uint256 keeperReward,
        uint256 toInsurance,
        uint256 badDebt
    );
    event BadDebtSocialized(uint256 requested, uint256 coveredByInsurance, uint256 uncovered);
    event OrderMarginChanged(address indexed account, uint256 reservedOrderMargin);
    event FeesCollected(address indexed to, uint256 amountToken);
    event RiskParamsUpdated(RiskParams params);
    event FundingParamsUpdated(FundingParams params);
    event PausedSet(bool paused);

    // ─── Errors ────────────────────────────────────────────────────────────────
    error NotLiquidatable();
    error PositionCapExceeded();
    error OpenInterestCapExceeded();
    error OracleStale();
    error ZeroAmount();
    error AlreadyInitialized();
    error Paused();
    /// @notice CR-006: out-of-bounds admin params, zero address, or self-liquidation.
    error InvalidParams();

    // ─── Collateral ────────────────────────────────────────────────────────────
    /// @param amountToken AUSD (6 dp). Credited as amountToken * 1e12 WAD.
    function deposit(uint256 amountToken) external;
    function depositFor(address account, uint256 amountToken) external;
    /// @notice Settles funding first; reverts InsufficientMargin if post-withdraw equity < initial margin.
    ///         Rounds the WAD debit UP (against the user).
    function withdraw(uint256 amountToken) external;

    // ─── Funding ───────────────────────────────────────────────────────────────
    /// @notice Idempotent within a block. Anyone may call (keepers poke idle markets).
    function updateFunding() external returns (int256 cumFunding);
    function settleFunding(address account) external;

    // ─── Liquidation ───────────────────────────────────────────────────────────
    /// @notice msg.sender (liquidator, must have margin in this market) takes over up to `maxSizeWad`
    ///         of `account`'s position at mark price. Penalty = liqPenalty * notional, split keeperShare
    ///         to liquidator and the rest to the insurance fund. Bad debt is pulled from the insurance fund.
    /// @return sizeTransferred signed size moved to the liquidator
    function liquidate(address account, uint256 maxSizeWad) external returns (int256 sizeTransferred);

    // ─── OrderBook hooks: see IMarginEngine (onlyOrderBook) ────────────────────

    // ─── Admin ─────────────────────────────────────────────────────────────────
    /// @notice One-shot wiring (CH and OB reference each other). Reverts AlreadyInitialized.
    function setOrderBook(address orderBook) external;
    function setRiskParams(RiskParams calldata params) external;
    function setFundingParams(FundingParams calldata params) external;
    function setPaused(bool paused) external;
    function collectFees(address to) external returns (uint256 amountToken);

    // ─── Views ─────────────────────────────────────────────────────────────────
    function collateralToken() external view returns (address);
    function oracle() external view returns (address);
    function insuranceFund() external view returns (address);
    function riskParams() external view returns (RiskParams memory);
    function fundingParams() external view returns (FundingParams memory);
    /// @notice Stored state (may lag by blocks).
    function fundingState() external view returns (FundingState memory);
    /// @notice State as if updateFunding() were called now.
    function previewFundingState() external view returns (FundingState memory);
    function markPrice() external view returns (uint256 priceWad);
    function indexPrice() external view returns (uint256 priceWad);
    function getPosition(address account) external view returns (Position memory);
    function getAccount(address account) external view returns (AccountView memory);
    function isLiquidatable(address account) external view returns (bool);
    /// @return longOI sum of long sizes (WAD) @return shortOI sum of |short sizes| (WAD). Always equal.
    function openInterest() external view returns (uint256 longOI, uint256 shortOI);
    function accruedFees() external view returns (uint256 amountWad);
    function totalBadDebt() external view returns (uint256 amountWad);
}
```

### `contracts/src/interfaces/IFundingRateOracle.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFundingRateOracle — Monad-native, per-block funding rate as a public primitive (FROZEN, CR-003)
/// @notice Implemented by the perp ClearingHouse. Two cumulative indices, both updated O(1) on the first touch
///         per block (MATH_SPEC §1.2, §1.8):
///           F = Σ rate_b · index_b · Δt_b   (quote WAD per 1 base)   — what a 1-unit long has paid
///           G = Σ index_b · Δt_b            (quote WAD · seconds)    — "notional-time" per 1 base
///         ⇒ time-and-price-weighted average rate over any window = ΔF / ΔG (per second, WAD).
///         Checkpoints: one ring-buffer entry every CHECKPOINT_BLOCKS (200 blocks ≈ 60 s), 1440 entries (≈ 24 h).
///         Writes happen inside the funding touch; no loops.
interface IFundingRateOracle {
    event FundingCheckpoint(uint32 indexed slot, uint64 blockNumber, int256 cumFunding, int256 cumIndexTime);

    error ObservationTooOld();

    /// @notice As if the market were touched now (includes not-yet-written accrual).
    function latestObservation() external view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber);
    /// @notice Most recent checkpoint at or before (block.number - blocksAgo). Reverts ObservationTooOld.
    function observe(uint64 blocksAgo)
        external
        view
        returns (int256 cumFunding, int256 cumIndexTime, uint64 observedBlock);
    /// @notice ΔF/ΔG between the checkpoint `blocksAgo` back and now; per-second WAD (signed).
    function averageFundingRate(uint64 blocksAgo) external view returns (int256 ratePerSecondWad);
    /// @notice averageFundingRate * 365 days; WAD (0.1e18 = 10% APR).
    function averageFundingApr(uint64 blocksAgo) external view returns (int256 aprWad);
}
```

### `contracts/src/interfaces/IFundingSwapMarket.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapParams, SwapPosition, SwapAccountView} from "./MeridianTypes.sol";
import {IMarginEngine} from "./IMarginEngine.sol";

/// @title IFundingSwapMarket — fixed-for-floating MON-PERP funding swaps, one maturity (FROZEN, CR-003)
/// @notice The "fix it" layer. Long = receive floating perp funding, pay a fixed APR. Short = the reverse.
///         Traded on its own IOrderBook instance where price = 1 + fixed APR (WAD); size = MON notional units.
///         Accrues per block in O(1) from the perp ClearingHouse's two indices (IFundingRateOracle):
///           floating received by a long = size * ΔF
///           fixed paid by a long        = fixedAprNotional * ΔG / SECONDS_PER_YEAR
///         Fill rule: settle both sides, then size += Δq and fixedAprNotional += Δq * apr (never reduced
///         proportionally) ⇒ Σsize = 0 and ΣK = 0 ⇒ accrual conserves exactly (MATH_SPEC §6.2).
///         Settlement is lazy on touch. After maturity, accrual stops at the maturity snapshot (settleMaturity).
///         Margin covers worst-case funding over liqHorizon + an implied-APR shock (MATH_SPEC §6).
interface IFundingSwapMarket is IMarginEngine {
    event Deposited(address indexed account, uint256 amountToken, uint256 amountWad);
    event Withdrawn(address indexed account, uint256 amountToken, uint256 amountWad);
    /// @param aprWad fixed APR of this fill (price - 1e18)
    event SwapPositionChanged(
        address indexed account,
        int256 sizeDelta,
        int256 newSize,
        int256 aprWad,
        int256 realizedPnl,
        int256 fee,
        bool isMaker
    );
    /// @param net floating received - fixed paid (quote WAD, + = credited to account)
    event SwapAccrualSettled(address indexed account, int256 floatingLeg, int256 fixedLeg, int256 net);
    event SwapLiquidated(
        address indexed account,
        address indexed liquidator,
        int256 sizeTransferred,
        int256 markAprWad,
        uint256 penalty,
        uint256 keeperReward,
        uint256 toInsurance,
        uint256 badDebt
    );
    event MaturitySettled(int256 cumFundingAtMaturity, int256 cumIndexTimeAtMaturity, uint64 blockNumber);
    event SwapParamsUpdated(SwapParams params);

    error Matured();
    error NotMatured();
    error NotLiquidatable();
    error PositionCapExceeded();
    error OpenInterestCapExceeded();
    error ZeroAmount();
    error AlreadyInitialized();
    error Paused();
    /// @notice Constructor/`setSwapParams` bounds, zero addresses, self-liquidation (CR-008, additive).
    error InvalidParams();

    // ─── Collateral (AUSD, same units as IClearingHouse) ────────────────────────
    function deposit(uint256 amountToken) external;
    function depositFor(address account, uint256 amountToken) external;
    function withdraw(uint256 amountToken) external;

    // ─── Accrual / lifecycle ────────────────────────────────────────────────────
    function settle(address account) external;
    /// @notice Callable by anyone once block.timestamp >= maturity; snapshots perp F and G. Idempotent.
    function settleMaturity() external;
    /// @notice Liquidator takes over x ≤ maxSizeWad and K·x/size, with an equal-and-opposite cash transfer of the
    ///         position value at markApr, then the penalty (MATH_SPEC §6.4).
    function liquidate(address account, uint256 maxSizeWad) external returns (int256 sizeTransferred);

    // ─── Admin ──────────────────────────────────────────────────────────────────
    function setOrderBook(address orderBook) external;
    function setSwapParams(SwapParams calldata params) external;
    function setPaused(bool paused) external;
    function collectFees(address to) external returns (uint256 amountToken);

    // ─── Views ──────────────────────────────────────────────────────────────────
    function perpClearingHouse() external view returns (address);
    function collateralToken() external view returns (address);
    function insuranceFund() external view returns (address);
    function maturity() external view returns (uint256 timestamp);
    function isMatured() external view returns (bool);
    function swapParams() external view returns (SwapParams memory);
    /// @notice Median of (book mid, last trade, trailing 8h realized funding APR), clamped. WAD, signed.
    function markApr() external view returns (int256 aprWad);
    /// @notice Trailing realized funding APR from the perp oracle (the "floating" reference shown in the UI).
    function realizedApr(uint64 blocksAgo) external view returns (int256 aprWad);
    function timeToMaturity() external view returns (uint256 sec);
    function getPosition(address account) external view returns (SwapPosition memory);
    function getAccount(address account) external view returns (SwapAccountView memory);
    function isLiquidatable(address account) external view returns (bool);
    function openInterest() external view returns (uint256 longOI, uint256 shortOI);
}
```

### `contracts/src/interfaces/IOracleAdapter.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOracleAdapter — index price for one market (FROZEN)
/// @notice Primary: Pyth pull feed (pushed by keeper/MM bot). Secondary: Chainlink push feed used as a
///         deviation guard. Both VERIFY'd live on Monad mainnet (see docs/ARCHITECTURE.md §Research).
interface IOracleAdapter {
    enum Source {
        Primary,
        Secondary
    }

    event PriceUpdated(uint256 priceWad, uint256 publishTime, Source source);
    event DeviationGuardTripped(uint256 primaryWad, uint256 secondaryWad);
    event OracleParamsUpdated(uint256 maxStalenessSec, uint256 maxDeviationWad);

    error StalePrice();
    error InvalidPrice();
    error PriceDeviation();
    error InsufficientUpdateFee();
    /// @notice Constructor/setter bounds violated (CR-005): maxStaleness ∈ [1, 3600] s, maxDeviation ∈ (0, 10%].
    error InvalidOracleParams();

    /// @notice Reverts StalePrice / InvalidPrice / PriceDeviation.
    /// @return priceWad quote per base, WAD
    /// @return updatedAt unix seconds of the observation
    function getIndexPrice() external view returns (uint256 priceWad, uint256 updatedAt);
    /// @notice Non-reverting variant used by the ClearingHouse to degrade gracefully.
    function tryGetIndexPrice() external view returns (bool ok, uint256 priceWad, uint256 updatedAt);
    /// @notice Push primary-source update data (Pyth). msg.value must cover updateFee(data); excess refunded.
    function updatePrice(bytes[] calldata updateData) external payable;
    function updateFee(bytes[] calldata updateData) external view returns (uint256 feeWei);

    function maxStaleness() external view returns (uint256 sec);
    function maxDeviation() external view returns (uint256 wad);
    function description() external view returns (string memory);
}
```

### `contracts/src/interfaces/IInsuranceFund.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInsuranceFund — AUSD backstop shared by all markets (FROZEN)
/// @notice Receives liquidation surplus by plain ERC20 transfer (balance-based accounting).
///         Only registered ClearingHouses may draw on it. Touched only on liquidation / bad debt,
///         never on the trading hot path.
interface IInsuranceFund {
    event Funded(address indexed from, uint256 amountToken);
    event BadDebtCovered(address indexed market, uint256 requestedToken, uint256 coveredToken);
    event MarketAuthorized(address indexed market, bool authorized);

    error UnauthorizedMarket();

    function asset() external view returns (address);
    function balance() external view returns (uint256 amountToken);
    function fund(uint256 amountToken) external;
    /// @notice Transfers min(requested, balance) to msg.sender.
    function coverBadDebt(uint256 requestedToken) external returns (uint256 coveredToken);
    function setMarketAuthorized(address market, bool authorized) external;
    function isAuthorized(address market) external view returns (bool);
}
```

### `contracts/src/interfaces/IMarketFactory.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMarketFactory — registry of perp markets (FROZEN)
/// @notice Markets are deployed by script (OrderBook and ClearingHouse reference each other, wired via
///         IClearingHouse.setOrderBook) and then registered here. The registry is read-mostly: it is never
///         touched on the trading hot path, so it causes no cross-market conflicts.
interface IMarketFactory {
    struct Market {
        bytes32 marketId; // keccak256(symbol), e.g. keccak256("MON-PERP")
        string symbol;
        address orderBook;
        address clearingHouse;
        address oracle;
        address baseAsset; // spot asset used by the vault hedge (e.g. WMON); informational
        bool active;
    }

    event MarketRegistered(
        bytes32 indexed marketId, string symbol, address orderBook, address clearingHouse, address oracle
    );
    event MarketStatusChanged(bytes32 indexed marketId, bool active);

    error MarketExists();
    error UnknownMarket();
    /// @notice CR-006: zero address, or the ClearingHouse is not wired to the given order book.
    error InvalidParams();

    function registerMarket(
        string calldata symbol,
        address orderBook,
        address clearingHouse,
        address oracle,
        address baseAsset
    ) external returns (bytes32 marketId);
    function setMarketActive(bytes32 marketId, bool active) external;

    function getMarket(bytes32 marketId) external view returns (Market memory);
    function marketIds() external view returns (bytes32[] memory); // bounded: tiny list (1-2 markets)
    function marketByClearingHouse(address clearingHouse) external view returns (bytes32 marketId);
}
```

### `contracts/src/interfaces/IMeridianVault.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {VaultParams, HedgeState} from "./MeridianTypes.sol";

/// @title IMeridianVault — delta-neutral funding vault, ERC-4626 over AUSD (FROZEN)
/// @notice "Skew absorber" basis vault. Deposit AUSD; keeper deploys it into spot MON (via IKuruHedger / Kuru Flow)
///         + short MON-PERP. Short size is capped by other traders' net long skew (VaultParams.skewCapacity) and
///         the hedge is only entered when funding pays for costs (MATH_SPEC §5).
///         totalAssets() = NAV in AUSD (6 dp). Shares have 18 decimals (decimals offset 12, inflation guard).
///         Deposits stay idle until the next rebalance, so a deposit never trades (sandwich-safe, cheap).
interface IMeridianVault is IERC4626 {
    enum RebalanceReason {
        None,
        Deploy, // idle above buffer
        DeltaDrift, // |netDelta| / N > driftBand
        MarginLow, // marginRatio < minMarginRatio
        ExitHedge, // smoothed funding below round-trip cost
        EnterHedge, // funding back above threshold
        Withdraw, // unwind to serve a withdrawal
        SkewCap // shrink the short because other traders' net long skew fell
    }

    event Rebalanced(
        RebalanceReason indexed reason,
        int256 spotDeltaBase,
        int256 perpDeltaBase,
        uint256 navAfter,
        uint256 sharePriceWad
    );
    event HedgeExited(uint256 navAfter);
    event HedgeEntered(uint256 navAfter);
    /// @notice Emitted on every NAV-changing op; source for the vault NAV / APY chart.
    event NavSnapshot(uint256 nav, uint256 totalShares, uint256 sharePriceWad, int256 fundingAccruedWad);
    event VaultParamsUpdated(VaultParams params);
    event KeeperUpdated(address indexed keeper, bool allowed);

    error OnlyKeeper();
    error NothingToDo();
    error SlippageExceeded();
    error DepositCapExceeded();
    /// @notice Constructor / `setVaultParams` bounds, zero addresses (CR-009, additive).
    error InvalidParams();

    // ─── CR-014 (interfaces-v1.7): async withdrawals beyond idle, routed exits, emergency unwind ───────────────
    /// @notice Pending: shares escrowed in the vault (still in totalSupply). Claimable: priced and paid into
    ///         `claimableAssets`, waiting for `claimRedeem`. Claimed / Cancelled: final.
    enum RedeemStatus {
        Pending,
        Claimable,
        Claimed,
        Cancelled
    }

    /// @notice One redemption request. `assets` (AUSD token units) is 0 until fulfilment, then the fixed payout.
    ///         An id whose `owner` is address(0) does not exist.
    struct RedeemRequest {
        address owner;
        uint64 requestedBlock;
        RedeemStatus status;
        address receiver;
        uint128 shares;
        uint128 assets;
    }

    event RedeemRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares);
    event RedeemCancelled(uint256 indexed id);
    /// @param unwindCost this request's pro-rata share of the batch's unwind cost (NAV lost), AUSD token units
    event RedeemFulfilled(uint256 indexed id, uint256 assets, uint256 unwindCost);
    event RedeemClaimed(uint256 indexed id, address indexed receiver, uint256 assets);
    event EmergencyUnwind(uint256 baseSold, uint256 perpBought, uint256 navAfter);

    error RequestNotFound();
    error NotRequestOwner();
    /// @notice previewRedeem(shares) of one request exceeds `maxSliceAssets` (split it).
    error RequestTooLarge();
    /// @notice A forced keeper path ran less than MIN_FORCED_INTERVAL_BLOCKS after the last rebalance (A-09).
    error CooldownActive();

    /// @notice Escrow `shares` of `owner` (ERC-4626 allowance rules when msg.sender ≠ owner) for an async
    ///         redemption beyond idle. The shares keep NAV exposure until fulfilment (priced then).
    function requestRedeem(uint256 shares, address receiver, address owner) external returns (uint256 id);
    /// @notice Owner only, Pending only: the escrowed shares go back to the owner.
    function cancelRedeem(uint256 id) external;
    /// @notice Keeper: price the Pending ids among `ids` (≤ MAX_BATCH; others are skipped) at the current NAV, unwind
    ///         a pro-rata slice of both legs through `spotRoute` if idle can't pay them, burn their shares and move
    ///         the payout into `claimableAssets`. The unwind cost is charged to this batch.
    function fulfillRedeems(uint256[] calldata ids, bytes calldata spotRoute) external;
    /// @notice Anyone: pay a Claimable request to its receiver (pull pattern).
    function claimRedeem(uint256 id) external returns (uint256 assets);
    /// @notice Keeper: forced exit of one slice with a Kuru Flow route (cooldown, A-09).
    function exitHedgeWithRoute(bytes calldata spotRoute) external;
    /// @notice Owner (Safe): buy back ≤ maxBase of the short (reduce-only), sell the same spot through `spotRoute`,
    ///         withdraw the perp collateral once flat, and clear the entered state. No cooldown; works while entered.
    function emergencyUnwind(uint256 maxBase, bytes calldata spotRoute) external;
    /// @notice Shares escrowed by Pending requests (included in totalSupply).
    function pendingRedeemShares() external view returns (uint256);
    /// @notice AUSD (token units) owed to Claimable requests; held by the vault, excluded from totalAssets().
    function claimableAssets() external view returns (uint256);
    /// @notice Reverts RequestNotFound for an unknown id.
    function getRedeemRequest(uint256 id) external view returns (RedeemRequest memory);
    /// @notice What `fulfillRedeems(ids, ·)` would do now: total payout before the unwind cost (AUSD token units)
    ///         and the spot base it would sell (WAD; 0 when idle covers the batch). For quoting the route (A-13).
    ///         Duplicate ids are counted once.
    function previewFulfill(uint256[] calldata ids) external view returns (uint256 assets, uint256 spotToSell);

    /// @notice Keeper entrypoint. Does whatever needsRebalance() reports using the direct Kuru route.
    function rebalance() external returns (RebalanceReason reason);
    /// @notice Same, with a Kuru Flow route for the spot leg (CR-002). minOut is computed by the vault from the
    ///         oracle index ± maxSlippage, never taken from the keeper.
    function rebalanceWithRoute(bytes calldata spotRoute) external returns (RebalanceReason reason);
    /// @notice Current cap on the vault's short from the skew rule, base WAD.
    function shortCapacity() external view returns (uint256 baseWad);
    /// @notice Forced exit / entry of one slice (keeper, empty route). CR-014: cooldown (CooldownActive).
    function exitHedge() external;
    function enterHedge() external;

    function needsRebalance() external view returns (RebalanceReason reason);
    function shouldExitHedge() external view returns (bool);
    function hedgeState() external view returns (HedgeState memory);
    /// @notice assets per 1e18 shares, WAD-scaled in asset units (1e6 AUSD per share => 1e18 at par).
    function sharePrice() external view returns (uint256);
    function vaultParams() external view returns (VaultParams memory);
    function clearingHouse() external view returns (address);
    function orderBook() external view returns (address);
    function hedger() external view returns (address);

    function setVaultParams(VaultParams calldata params) external;
    function setKeeper(address keeper, bool allowed) external;
}
```

### `contracts/src/interfaces/IKuruHedger.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruHedger — stateless spot-leg adapter to one Kuru market (FROZEN)
/// @notice Vault transfers tokens in; hedger swaps and returns output to the vault in the same call. Holds no
///         balances between calls. CR-002: `route` empty ⇒ direct market order on the configured Kuru market;
///         non-empty ⇒ low-level call ONLY to the KuruFlowEntrypoint with keeper-supplied calldata
///         (ws.kuru.io/api/quote), exact-amount approval reset to 0 afterwards, output verified by balance delta
///         >= minOut. Native MON is wrapped to WMON before returning. Kuru ABI: external/IKuruOrderBook.sol.
interface IKuruHedger {
    event SpotBought(address indexed vault, uint256 quoteInToken, uint256 baseOut, uint256 avgPriceWad);
    event SpotSold(address indexed vault, uint256 baseIn, uint256 quoteOutToken, uint256 avgPriceWad);

    error OnlyVault();
    error SlippageExceeded();
    error RouteCallFailed();
    /// @notice Constructor / one-shot vault wiring: zero address or already set (CR-009, additive).
    error InvalidParams();

    /// @param quoteInToken AUSD (6 dp) pulled from msg.sender
    /// @return baseOut base token units (WMON, 18 dp) sent to msg.sender
    function buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes calldata route) external returns (uint256 baseOut);
    /// @param baseIn base token units pulled from msg.sender
    /// @return quoteOutToken AUSD (6 dp) sent to msg.sender
    function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata route)
        external
        returns (uint256 quoteOutToken);

    /// @return bidWad best bid, WAD (0 if none) @return askWad best ask, WAD (max if none)
    function bestBidAsk() external view returns (uint256 bidWad, uint256 askWad);
    function kuruMarket() external view returns (address);
    function flowEntrypoint() external view returns (address);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
}
```

### `contracts/src/interfaces/IMeridianKeeperReceiver.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IMeridianKeeperReceiver — onchain target for Chainlink CRE workflow reports (FROZEN)
/// @notice CRE delivers signed reports through a Chainlink KeystoneForwarder which calls onReport.
///         IReceiver.onReport(bytes metadata, bytes report) confirmed in CRE docs; the forwarder checks ERC-165
///         support first. Monad KeystoneForwarder (CRE Forwarder Directory, verified has code):
///         mainnet 0x76c9cf548b4179F8901cda1f8623568b58215E62 (simulation: 0x9eF6468C5f37b976E57d52054c693269479A784d),
///         testnet 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 (simulation: 0xB9F79d863261869B234c481D1f9A7af84AeAd192).
///         report = abi.encode(uint8 action, bytes payload):
///           1 VAULT_REBALANCE  payload = abi.encode(address vault)
///           2 LIQUIDATE        payload = abi.encode(address clearingHouse, address[] accounts)  (len <= 32)
///           3 FUNDING_POKE     payload = abi.encode(address[] clearingHouses)                    (len <= 32)
///           4 ORACLE_UPDATE    payload = abi.encode(address oracleAdapter, bytes[] updateData)
///           5 UNWIND           payload = abi.encode(address clearingHouse, uint256 maxSizeWad)    (CR-016)
///           6 MFI_PUBLISH      payload = abi.encode(address feed, int256 mfiAprWad, int256 meridianAprWad,
///                                                   int256 perplAprWad, uint64 blockNumber, uint64 perplFundingBlock)
///                                                                                                 (CR-016)
///         metadata (production KeystoneForwarder) = workflowId (32) ‖ workflowName (10) ‖ workflowOwner (20) ‖
///         reportId (2) = 64 bytes; the simulation forwarder may pass less.
interface IMeridianKeeperReceiver is IERC165 {
    event ReportExecuted(uint8 indexed action, bool success, bytes32 workflowId);
    event ForwarderUpdated(address indexed forwarder);
    /// @notice CR-016: the receiver's reduce-only IOC on the position it inherited from LIQUIDATE.
    event Unwound(address indexed clearingHouse, bool isBid, uint64 lotsRequested, uint64 lotsFilled);
    /// @notice CR-016: zero = that check is off (simulation: the mock forwarder carries no owner / name).
    event ExpectedWorkflowUpdated(address workflowOwner, bytes32 workflowId);

    error OnlyForwarder();
    error UnknownAction(uint8 action);
    /// @notice CR-016: metadata's workflow owner (bytes 42..62) differs from the expected one (or metadata < 62 bytes).
    error InvalidWorkflowOwner(address got);
    /// @notice CR-016: metadata's workflowId (bytes 0..32) differs from the expected one (or metadata < 62 bytes).
    error InvalidWorkflowId(bytes32 got);

    function onReport(bytes calldata metadata, bytes calldata report) external;
    function forwarder() external view returns (address);
    function setForwarder(address forwarder) external;

    // ─── CR-016 (interfaces-v1.8) ──────────────────────────────────────────────
    /// @notice Owner: workflow identity required in every report's metadata (production delivery). Zero disables.
    function setExpectedWorkflow(address workflowOwner, bytes32 workflowId) external;
    function expectedWorkflowOwner() external view returns (address);
    function expectedWorkflowId() external view returns (bytes32);
    /// @notice Owner: withdraw the receiver's margin from `clearingHouse` (AUSD token units) and send it to `to`.
    function withdrawMargin(address clearingHouse, uint256 amountToken, address to) external;
    /// @notice Owner: recover ERC-20s / MON held by the receiver.
    function sweepToken(address token, address to, uint256 amount) external;
    function sweepNative(address payable to, uint256 amount) external;
}
```

### `contracts/src/interfaces/external/AggregatorV3Interface.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AggregatorV3Interface — Chainlink push feed (external, standard ABI)
/// @notice Monad mainnet proxies (monad-crypto/protocols chainlink.jsonc; all verified live onchain,
///         8 decimals. MON/USD observed updating every ~minutes, i.e. deviation/heartbeat-driven: guard only):
///         MON/USD 0xBcD78f76005B7515837af6b50c7C52BCf73822fb, ETH/USD 0x1B1414782B859871781bA3E4B0979b9ca57A0A04,
///         AUSD/USD 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
```

### `contracts/src/interfaces/external/IKuruMarginAccount.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruMarginAccount — subset (external). Source: https://docs.kuru.io/contracts/MarginAccount
/// @notice Mainnet MarginAccount per Kuru docs: 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5 (verified: holds ~60k AUSD across Kuru markets).
interface IKuruMarginAccount {
    function deposit(address _user, address _token, uint256 _amount) external payable;
    function withdraw(uint256 _amount, address _token) external;
    function getBalance(address _user, address _token) external view returns (uint256);
}
```

### `contracts/src/interfaces/external/IKuruOrderBook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruOrderBook — subset of Kuru's OrderBook used by KuruHedger (external, not ours)
/// @notice Signatures taken from the kuru-sdk ABI (github.com/Kuru-Labs/kuru-sdk abi/OrderBook.json) and
///         VERIFIED by a mainnet-fork buy+sell on MON/USDC (2026-09-29, see docs/ARCHITECTURE.md R17).
///         NOTE: docs.kuru.io is WRONG on several points (minOut width, return values, bestBidAsk types) — CR-001.
///         Units (verified on fork):
///           - placeAndExecuteMarketBuy._quoteSize : quote amount in market pricePrecision units
///             (MON/USDC pricePrecision = 1e8 ⇒ 10 USDC = 1e9). Pulls quote via transferFrom when !_isMargin.
///           - placeAndExecuteMarketSell._size     : base amount in market sizePrecision units (1e10 on MON markets);
///             for native-MON-base markets send msg.value = size * 1e18 / sizePrecision.
///           - return value                         : amount received, in the output token's native decimals.
///           - bestBidAsk / getL2Book prices        : 1e18-scaled (bestBidAsk) / pricePrecision-scaled (L2 book).
interface IKuruOrderBook {
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );

    function addBuyOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    function addSellOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function batchCancelOrders(uint40[] calldata _orderIds) external;
    /// @return bestBid 1e18-scaled (type(uint256).max / 0 patterns seen on empty books — treat as "no quote")
    function bestBidAsk() external view returns (uint256, uint256);
    /// @return pricePrecision, sizePrecision, baseAsset, baseAssetDecimals, quoteAsset, quoteAssetDecimals,
    ///         tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);
    function getL2Book() external view returns (bytes memory);
}
```

### `contracts/src/interfaces/external/IKuruRouter.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruRouter — subset (external). Source: https://docs.kuru.io/contracts/Router
/// @notice Mainnet Router (market factory): 0xd651346d7c789536ebf06dc72aE3C8502cd695CC (verified: has code, owner
///         0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b).
///         OrderBookType: 0 = two ERC20s, 1 = base is native MON, 2 = quote is native MON.
///         deployProxy is NOT permissionless: eth_call from a random EOA reverts Unauthorized() (0x82b42900),
///         verified 2026-09-29. Listing a new market requires the Kuru team (see RISKS T2).
///         kuruAmmSpread: 10–500 bps, multiple of 10 (docs: 100 for volatile, 30 for stable pairs).
interface IKuruRouter {
    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy);

    function anyToAnySwap(
        address[] calldata _marketAddresses,
        bool[] calldata _isBuy,
        bool[] calldata _nativeSend,
        address _debitToken,
        address _creditToken,
        uint256 _amount,
        uint256 _minAmountOut
    ) external payable returns (uint256 _amountOut);
}
```

### `contracts/src/interfaces/external/IPerplExchange.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPerplExchange — the subset of Perpl's Exchange that PerplFundingSource reads (external, CR-017)
/// @notice Copied from the vendored ABI `indexer/abis/PerplExchange.json` (dex-sdk dbb37c5, contract 1.7.5): only the
///         two views and the one event the adapter relies on. Testnet exchange (ERC-1967 proxy)
///         0x1964c32f0be608e7d29302aff5e61268e72080cc (`deployments/perpl.json`).
///         Units (docs/PERPL_SWAPS.md §Units, verified 12 Oct 2026 on 10143 perp 64):
///         - `fundingSumPNS` is a per-1-lot cumulative funding sum in price units ×10^fundingSumScalingExp; it RISES
///           when longs pay. F_wad = fundingSumPNS · 10^(18 − priceDecimals − fundingSumScalingExp).
///         - `fundingEventBlock` (feb) is the block a funding event applies from; the sum for feb is written ~78 blocks
///           earlier but `getFundingSumAtBlock(perp, b)` only returns it for b ≥ feb.
///         - `fundingRatePct100k`, `absFundingClampPctPer100K`: fraction of notional per funding interval ×1e5.
///         - `oraclePNS` / `markPNS`: price ×10^priceDecimals; `oracleTimestampSec`: unix seconds.
interface IPerplExchange {
    struct PerpetualInfoV2 {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
        uint256 fundingSumScalingExp;
    }

    event FundingEventCompleted(
        uint256 perpId,
        uint256 fundingEventBlock,
        int256 specifiedRatePct100k,
        int256 actualRatePct100k,
        uint256 fundingPricePNS,
        int48 fundingPaymentPNS,
        int48 fundingSumPNS,
        bool allowOverwrite
    );

    /// @notice Cumulative funding sum of the latest funding event at or before `blockNumber`, and that event's block.
    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
        external
        view
        returns (int48 fundingSumPNS, uint256 fundingEventBlock);

    /// @notice Funding interval in blocks (8,571 on 10143 and 143). `pure` in Perpl's ABI; declared `view` here so a
    ///         mock can script it (same selector, called with STATICCALL either way).
    function getFundingInterval() external view returns (uint256 fundingInterval);

    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory perpetualInfo);
}
```

### `contracts/src/interfaces/external/IPythMinimal.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPythMinimal — subset of Pyth's IPyth (external). WS-03 may swap for @pythnetwork/pyth-sdk-solidity.
/// @notice Monad mainnet Pyth: 0x2880aB155794e7179c9eE2e38200202908C17B43 (monad-crypto/protocols, VERIFY).
interface IPythMinimal {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}
```

### `contracts/src/interfaces/IMeridianMfiFeed.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMeridianMfiFeed — the Meridian Funding Index onchain, under Chainlink CRE DON consensus (CR-016, FROZEN)
/// @notice MFI = open-interest-weighted mean of the annualized MON-perp funding rate on Meridian and Perpl
///         (docs/MFI.md §1, §4.2). A CRE workflow computes it from Meridian's `averageFundingApr(12_000)` (EVM read)
///         and Perpl's funding (HTTP, DON consensus) and publishes it through `IMeridianKeeperReceiver` action 6.
///         All APRs are annualized WAD (0.1e18 = 10% APR), positive ⇒ longs pay shorts; rounding neutral (MFI §4.4).
///         Any contract can read `latest()`.
interface IMeridianMfiFeed {
    /// @param blockNumber Monad block the workflow read Meridian at (strictly increasing)
    /// @param perplFundingBlock Monad block of the Perpl funding event used (`FundingEvent.at.b`), 0 if not included
    event MfiPublished(
        int256 mfiAprWad,
        int256 meridianAprWad,
        int256 perplAprWad,
        uint64 indexed blockNumber,
        uint64 perplFundingBlock
    );

    error OnlyReceiver();
    /// @notice A report for a block not after the stored one (stale / replayed), or after the current block.
    error StaleObservation(uint64 got, uint64 last);
    /// @notice |APR| > MAX_ABS_APR_WAD, or the MFI outside [min, max] of the venue APRs.
    error AprOutOfBounds(int256 aprWad);

    /// @notice Receiver only. Venue APRs not included are passed equal to the MFI (Meridian-only: perpl = mfi).
    function publish(
        int256 mfiAprWad,
        int256 meridianAprWad,
        int256 perplAprWad,
        uint64 blockNumber,
        uint64 perplFundingBlock
    ) external;

    /// @return mfiAprWad the index
    /// @return meridianAprWad Meridian 1 h APR
    /// @return perplAprWad Perpl APR
    /// @return blockNumber observation block (0 = never published)
    /// @return perplFundingBlock Perpl funding event block
    function latest()
        external
        view
        returns (
            int256 mfiAprWad,
            int256 meridianAprWad,
            int256 perplAprWad,
            uint64 blockNumber,
            uint64 perplFundingBlock
        );

    function receiver() external view returns (address);
}
```

### `contracts/src/interfaces/IPerplFundingSource.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFundingRateOracle} from "./IFundingRateOracle.sol";
import {FundingParams, FundingState} from "./MeridianTypes.sol";

/// @title IPerplFundingSource — Perpl's per-interval funding as a Meridian funding source (CR-017, interfaces-v1.9)
/// @notice A `FundingSwapMarket` reads its floating leg through seven views on the address it was deployed with
///         (`latestObservation`, `observe`, `averageFundingRate`, `averageFundingApr`, `indexPrice`,
///         `fundingParams().rateCap`, `fundingState().rate`). This adapter answers them from snapshots of one Perpl
///         perpetual, so a second swap market can settle on Perpl's funding without any change to the swap market.
///         - `poke()` (permissionless) snapshots Perpl's cumulative funding sum when a new funding event has applied:
///           F = fundingSumPNS · 10^(18 − priceDecimals − fundingSumScalingExp) (quote WAD per 1 base, rises when
///           longs pay, same convention as the ClearingHouse), and G += I · Δfeb · intervalSec / intervalBlocks with
///           I = Perpl's oracle price at the poke. F and G step together, once per Perpl funding event.
///         - Every view answers from storage only (no call into Perpl); nothing is extrapolated.
///         - Checkpoints: one ring entry per poke that advances, RING_SIZE entries, observation block = the Perpl
///           funding event block (feb). MATH_SPEC §6.8.
interface IPerplFundingSource is IFundingRateOracle {
    /// @notice A new Perpl funding event was snapshotted.
    /// @param cumFunding F after the poke (quote WAD per 1 base)
    /// @param cumIndexTime G after the poke (quote WAD · seconds per 1 base)
    /// @param fundingEventBlock Perpl's funding event block the snapshot is as of
    /// @param priceWad I used for this step of G (Perpl oracle price, WAD)
    /// @param rate Perpl's current funding rate as a per-second WAD rate
    event Poked(int256 cumFunding, uint256 cumIndexTime, uint64 fundingEventBlock, uint256 priceWad, int256 rate);

    /// @notice Perpl's oracle price is older than MAX_PRICE_AGE (or zero): nothing is written, F and G pause together.
    error StalePerplPrice(uint256 oracleTimestampSec);
    /// @notice Perpl changed the market's priceDecimals or fundingSumScalingExp since deploy: the sum's unit moved.
    error PerplScaleChanged();
    /// @notice Constructor bounds: zero exchange, decimals + scaling exponent > 18, zero interval.
    error InvalidParams();

    /// @notice Snapshot Perpl's funding if a new funding event has applied since the last snapshot. Permissionless.
    /// @return advanced true if a new observation was written (false = no new funding event, nothing changed)
    function poke() external returns (bool advanced);

    /// @notice Perpl Exchange (proxy) this adapter reads.
    function exchange() external view returns (address);
    /// @notice Perpl perpetual id (testnet MON = 64).
    function perpId() external view returns (uint256);
    /// @notice Perpl funding interval in blocks (read at deploy).
    function fundingIntervalBlocks() external view returns (uint256);
    /// @notice Perpl funding interval in seconds (deploy parameter, `deployments/perpl.json`).
    function fundingIntervalSec() external view returns (uint256);
    /// @notice F_wad = fundingSumPNS · sumScale.
    function sumScale() external view returns (uint256);
    /// @notice Block of the last poke that wrote an observation.
    function lastPokeBlock() external view returns (uint64);
    /// @notice Raw ring entry `slot` (for indexers and invariant handlers).
    function checkpointAt(uint256 slot)
        external
        view
        returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber);
    /// @notice Index of the newest ring entry.
    function checkpointIndex() external view returns (uint256);

    /// @notice Perpl oracle price at the last poke (WAD). Same selector as IClearingHouse.indexPrice.
    function indexPrice() external view returns (uint256 priceWad);
    /// @notice Same ABI as IClearingHouse.fundingParams. Only `rateCap` is meaningful (Perpl's clamp per second WAD,
    ///         with a price-basis buffer); `blockTimeMs` = intervalSec·1000/intervalBlocks; every other field is 0.
    function fundingParams() external view returns (FundingParams memory);
    /// @notice Same ABI as IClearingHouse.fundingState: (F, G, 0, Perpl's rate per second WAD, feb).
    function fundingState() external view returns (FundingState memory);
}
```
