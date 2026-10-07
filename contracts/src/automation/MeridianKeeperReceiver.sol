// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IMeridianKeeperReceiver} from "../interfaces/IMeridianKeeperReceiver.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IMeridianVault} from "../interfaces/IMeridianVault.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IMeridianMfiFeed} from "../interfaces/IMeridianMfiFeed.sol";
import {MeridianConstants, RiskParams, Position, AccountView} from "../interfaces/MeridianTypes.sol";

/// @title MeridianKeeperReceiver — Chainlink CRE backstop keeper for Meridian
/// @notice A CRE workflow's DON-signed report reaches `onReport` through the Chainlink KeystoneForwarder. The report
///         is `abi.encode(uint8 action, bytes payload)` (IMeridianKeeperReceiver): 1 VAULT_REBALANCE, 2 LIQUIDATE,
///         3 FUNDING_POKE, 4 ORACLE_UPDATE (mainnet / Pyth only), 5 UNWIND, 6 MFI_PUBLISH (CR-016). Every external call
///         is isolated: one failing account or market never reverts the report, `ReportExecuted.success` is true only if
///         every item succeeded.
/// @dev LIQUIDATE makes this contract the liquidator: it must hold margin in that ClearingHouse (`depositFor`) and it
///      inherits the positions it takes. Each take is sized to the receiver's own cap and IM headroom (same rule as
///      keepers/ts-fallback/src/unwind.ts `liquidationHeadroom`), so a take never reverts on the receiver's limits.
///      UNWIND then closes what it inherited with a reduce-only IOC at index ± 1% (unwind.ts `unwindPlan`).
///      Only `forwarder` may call `onReport`. With the simulation MockKeystoneForwarder that is the whole gate (the mock
///      carries no workflow owner / name); production delivery also sets `setExpectedWorkflow` (CR-016).
contract MeridianKeeperReceiver is IMeridianKeeperReceiver, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint8 public constant VAULT_REBALANCE = 1;
    uint8 public constant LIQUIDATE = 2;
    uint8 public constant FUNDING_POKE = 3;
    uint8 public constant ORACLE_UPDATE = 4;
    uint8 public constant UNWIND = 5;
    uint8 public constant MFI_PUBLISH = 6;
    /// @notice UNWIND's worst price vs the index: 1%, as the TS keeper (`MAX_SLIPPAGE_BPS`).
    uint256 public constant UNWIND_SLIPPAGE_BPS = 100;
    /// @notice Safety margin on the receiver's IM capacity (mark drift, IM rounding): 2%, as the TS keeper.
    uint256 public constant HEADROOM_BUFFER_BPS = 200;

    /// @inheritdoc IMeridianKeeperReceiver
    address public forwarder;
    /// @inheritdoc IMeridianKeeperReceiver
    address public expectedWorkflowOwner;
    /// @inheritdoc IMeridianKeeperReceiver
    bytes32 public expectedWorkflowId;

    constructor(address forwarder_, address owner_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Pays Pyth update fees (ORACLE_UPDATE) and receives the oracle's fee refunds.
    receive() external payable {}

    // ─── IReceiver ─────────────────────────────────────────────────────────────

    /// @inheritdoc IMeridianKeeperReceiver
    /// @dev `metadata` is 64 bytes from the production forwarder (workflowId ‖ name ‖ owner ‖ reportId) and may be
    ///      shorter from the simulation forwarder: the workflowId is its first 32 bytes, else 0. Its length matters only
    ///      while an identity check is on (≥ 62 bytes: 62 and 64 both accepted).
    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (msg.sender != forwarder) revert OnlyForwarder();
        _checkIdentity(metadata);
        (uint8 action, bytes memory payload) = abi.decode(report, (uint8, bytes));
        bool success;
        if (action == LIQUIDATE) success = _liquidate(payload);
        else if (action == FUNDING_POKE) success = _fundingPoke(payload);
        else if (action == VAULT_REBALANCE) success = _vaultRebalance(payload);
        else if (action == UNWIND) success = _unwind(payload);
        else if (action == MFI_PUBLISH) success = _mfiPublish(payload);
        else if (action == ORACLE_UPDATE) success = _oracleUpdate(payload);
        else revert UnknownAction(action);
        emit ReportExecuted(action, success, metadata.length >= 32 ? bytes32(metadata[:32]) : bytes32(0));
    }

    /// @notice ERC-165: IReceiver (the forwarder checks it before delivering), IMeridianKeeperReceiver, IERC165.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // type(IReceiver).interfaceId = onReport.selector (IReceiver declares only onReport)
        return interfaceId == IMeridianKeeperReceiver.onReport.selector
            || interfaceId == type(IMeridianKeeperReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _checkIdentity(bytes calldata metadata) internal view {
        address wantOwner = expectedWorkflowOwner;
        bytes32 wantId = expectedWorkflowId;
        if (wantOwner == address(0) && wantId == bytes32(0)) return;
        if (metadata.length < 62) {
            if (wantId != bytes32(0)) revert InvalidWorkflowId(bytes32(0));
            revert InvalidWorkflowOwner(address(0));
        }
        bytes32 id = bytes32(metadata[:32]);
        if (wantId != bytes32(0) && id != wantId) revert InvalidWorkflowId(id);
        address wfOwner = address(bytes20(metadata[42:62]));
        if (wantOwner != address(0) && wfOwner != wantOwner) revert InvalidWorkflowOwner(wfOwner);
    }

    // ─── Actions ───────────────────────────────────────────────────────────────

    /// @dev payload = abi.encode(address vault). Needs vault.setKeeper(this, true).
    function _vaultRebalance(bytes memory payload) internal returns (bool) {
        address vault = abi.decode(payload, (address));
        return _call(vault, abi.encodeCall(IMeridianVault.rebalance, ()));
    }

    /// @dev payload = abi.encode(address[] clearingHouses), ≤ MAX_BATCH. updateFunding() is permissionless.
    function _fundingPoke(bytes memory payload) internal returns (bool ok) {
        address[] memory chs = abi.decode(payload, (address[]));
        if (chs.length > MeridianConstants.MAX_BATCH) revert IOrderBook.BatchTooLarge();
        ok = true;
        for (uint256 i; i < chs.length; ++i) {
            if (!_call(chs[i], abi.encodeCall(IClearingHouse.updateFunding, ()))) ok = false;
        }
    }

    /// @dev payload = abi.encode(address oracleAdapter, bytes[] updateData). The fee is paid from this contract's
    ///      MON balance; Pyth refunds any excess to `receive`.
    function _oracleUpdate(bytes memory payload) internal returns (bool) {
        (address oracle, bytes[] memory data) = abi.decode(payload, (address, bytes[]));
        if (data.length > MeridianConstants.MAX_BATCH) revert IOrderBook.BatchTooLarge();
        if (oracle.code.length == 0) return false;
        uint256 fee;
        try IOracleAdapter(oracle).updateFee(data) returns (uint256 f) {
            fee = f;
        } catch {
            return false;
        }
        if (fee > address(this).balance) return false;
        try IOracleAdapter(oracle).updatePrice{value: fee}(data) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev payload = abi.encode(address clearingHouse, address[] accounts), ≤ MAX_BATCH. Market params are read once;
    ///      the receiver's own account is re-read before each take (its size grows with every take).
    function _liquidate(bytes memory payload) internal returns (bool ok) {
        (address chAddr, address[] memory accounts) = abi.decode(payload, (address, address[]));
        if (accounts.length > MeridianConstants.MAX_BATCH) revert IOrderBook.BatchTooLarge();
        if (chAddr.code.length == 0) return accounts.length == 0;
        IClearingHouse ch = IClearingHouse(chAddr);
        (bool read, Market memory m) = _market(ch);
        if (!read) return accounts.length == 0;
        ok = true;
        for (uint256 i; i < accounts.length; ++i) {
            if (!_liquidateOne(ch, m, accounts[i])) ok = false;
        }
    }

    struct Market {
        uint256 mark;
        uint256 imr;
        uint256 maxPositionSize;
        uint256 lotSize;
    }

    function _market(IClearingHouse ch) internal view returns (bool, Market memory m) {
        try ch.markPrice() returns (uint256 mark) {
            m.mark = mark;
        } catch {
            return (false, m);
        }
        try ch.riskParams() returns (RiskParams memory rp) {
            m.imr = rp.imr;
            m.maxPositionSize = rp.maxPositionSize;
        } catch {
            return (false, m);
        }
        try ch.orderBook() returns (address ob) {
            if (ob.code.length == 0) return (false, m);
            try IOrderBook(ob).lotSize() returns (uint256 lot) {
                m.lotSize = lot == 0 ? 1 : lot;
            } catch {
                return (false, m);
            }
        } catch {
            return (false, m);
        }
        return (true, m);
    }

    function _liquidateOne(IClearingHouse ch, Market memory m, address account) internal returns (bool) {
        if (account == address(this)) return false; // CH rejects self-liquidation (InvalidParams)
        int256 target;
        try ch.getPosition(account) returns (Position memory p) {
            target = p.size;
        } catch {
            return false;
        }
        AccountView memory me;
        try ch.getAccount(address(this)) returns (AccountView memory v) {
            me = v;
        } catch {
            return false;
        }
        uint256 x = liquidationHeadroom(
            me.size, me.equity, me.reservedOrderMargin, target, m.mark, m.imr, m.maxPositionSize, m.lotSize
        );
        if (x == 0) return false;
        try ch.liquidate(account, x) returns (int256) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Largest lot-aligned take x ≤ |targetSize| that ClearingHouse.liquidate accepts for the receiver's own
    ///         limits (position cap, equity ≥ IM after the take). 0 = no headroom. Port of unwind.ts
    ///         `liquidationHeadroom` (H-1). With q = the receiver's size in the take direction and
    ///         A = ⌊(equity − reserved)·(1 − buffer) / (mark·imr)⌋:
    ///           q ≥ 0: x ≤ min(cap, A) − q;   q < 0: |q| − A ≤ x ≤ |q| + min(cap, A).
    function liquidationHeadroom(
        int256 keeperSize,
        int256 keeperEquity,
        uint256 keeperReserved,
        int256 targetSize,
        uint256 markWad,
        uint256 imr,
        uint256 maxPositionSize,
        uint256 lotSize
    ) public pure returns (uint256 x) {
        uint256 want = FPM.abs(targetSize);
        if (want == 0 || lotSize == 0 || markWad == 0 || imr == 0) return 0;
        int256 free = keeperEquity - int256(keeperReserved);
        // equity < reserved order margin: ClearingHouse.liquidate fails IM for every resulting size, even flat
        if (free < 0) return 0;
        // MATH_SPEC §3.3 (liquidator IM check), rounds down: IM per base unit rounds up, A rounds down
        uint256 perUnitIm = FPM.mulWadUp(markWad, imr);
        uint256 a = FPM.fullMulDiv(
            uint256(free),
            (MeridianConstants.BPS - HEADROOM_BUFFER_BPS) * MeridianConstants.WAD,
            MeridianConstants.BPS * perUnitIm
        );
        int256 q = targetSize > 0 ? keeperSize : -keeperSize;
        uint256 capOrIm = FPM.min(maxPositionSize, a);
        uint256 hi;
        uint256 lo;
        if (q >= 0) {
            hi = capOrIm > uint256(q) ? capOrIm - uint256(q) : 0;
        } else {
            uint256 nq = uint256(-q);
            hi = nq + capOrIm;
            lo = nq > a ? nq - a : 0;
        }
        // rounds down to whole lots (the take must be unwindable on the book)
        x = FPM.min(hi, want) / lotSize * lotSize;
        if (x < lo) x = 0;
    }

    /// @dev payload = abi.encode(address clearingHouse, uint256 maxSizeWad). Closes up to maxSizeWad of the receiver's
    ///      own position with a reduce-only IOC on clearingHouse.orderBook(): whole lots, worst price index ± 1%.
    ///      Flat or < 1 lot: nothing to do (success). Stale index: failure (pricing the bound off it would be wrong).
    function _unwind(bytes memory payload) internal returns (bool) {
        (address chAddr, uint256 maxSize) = abi.decode(payload, (address, uint256));
        if (chAddr.code.length == 0) return false;
        IClearingHouse ch = IClearingHouse(chAddr);
        int256 size;
        try ch.getPosition(address(this)) returns (Position memory p) {
            size = p.size;
        } catch {
            return false;
        }
        if (size == 0) return true;
        (bool ok, IOrderBook ob, uint256 lot, uint256 tick, uint256 index) = _book(ch);
        if (!ok) return false;
        uint256 lots = FPM.min(FPM.abs(size), maxSize) / lot;
        if (lots == 0) return true;
        if (lots > type(uint64).max) lots = type(uint64).max;
        bool isBid = size < 0;
        uint256 limitTick = unwindLimitTick(isBid, index, tick);
        if (limitTick == 0 || limitTick > type(uint32).max) return false;
        try ob.placeMarketOrder(isBid, uint64(lots), uint32(limitTick), 0, true) returns (uint64 filled, uint256) {
            emit Unwound(chAddr, isBid, uint64(lots), filled);
            return filled != 0;
        } catch {
            return false;
        }
    }

    function _book(IClearingHouse ch)
        internal
        view
        returns (bool ok, IOrderBook ob, uint256 lot, uint256 tick, uint256 index)
    {
        try ch.orderBook() returns (address a) {
            ob = IOrderBook(a);
        } catch {
            return (false, ob, 0, 0, 0);
        }
        try ch.oracle() returns (address o) {
            if (o.code.length == 0 || address(ob).code.length == 0) return (false, ob, 0, 0, 0);
            try IOracleAdapter(o).tryGetIndexPrice() returns (bool fresh, uint256 p, uint256) {
                if (!fresh || p == 0) return (false, ob, 0, 0, 0);
                index = p;
            } catch {
                return (false, ob, 0, 0, 0);
            }
        } catch {
            return (false, ob, 0, 0, 0);
        }
        try ob.lotSize() returns (uint256 l) {
            lot = l;
        } catch {
            return (false, ob, 0, 0, 0);
        }
        try ob.tickSize() returns (uint256 t) {
            tick = t;
        } catch {
            return (false, ob, 0, 0, 0);
        }
        ok = lot != 0 && tick != 0;
    }

    /// @notice UNWIND's IOC limit tick: a bid's worst price index·(1 + 1%) floored to a tick, an ask's index·(1 − 1%)
    ///         ceiled to a tick, so the bound is never looser than 1% (unwind.ts `unwindPlan`). 0 = no valid tick.
    function unwindLimitTick(bool isBid, uint256 indexWad, uint256 tickSize) public pure returns (uint256) {
        if (tickSize == 0) return 0;
        if (isBid) {
            // MATH_SPEC §3.3 (keeper unwind bound), rounds down: tighter for a buy
            return FPM.mulDiv(indexWad, MeridianConstants.BPS + UNWIND_SLIPPAGE_BPS, MeridianConstants.BPS) / tickSize;
        }
        // MATH_SPEC §3.3 (keeper unwind bound), rounds up: tighter for a sell
        uint256 worst = FPM.mulDivUp(indexWad, MeridianConstants.BPS - UNWIND_SLIPPAGE_BPS, MeridianConstants.BPS);
        return FPM.divUp(worst, tickSize);
    }

    /// @dev payload = abi.encode(address feed, int256 mfiAprWad, int256 meridianAprWad, int256 perplAprWad,
    ///      uint64 blockNumber, uint64 perplFundingBlock). The feed rejects stale / replayed / out-of-bounds values;
    ///      that is a failure, not a revert.
    function _mfiPublish(bytes memory payload) internal returns (bool) {
        (address feed, int256 mfi, int256 meridian, int256 perpl, uint64 blockNumber, uint64 perplBlock) =
            abi.decode(payload, (address, int256, int256, int256, uint64, uint64));
        return _call(feed, abi.encodeCall(IMeridianMfiFeed.publish, (mfi, meridian, perpl, blockNumber, perplBlock)));
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IMeridianKeeperReceiver
    /// @dev Production: the workflow owner address and/or the workflowId (`cre workflow hash`). Zero turns a check off.
    function setExpectedWorkflow(address workflowOwner, bytes32 workflowId) external onlyOwner {
        expectedWorkflowOwner = workflowOwner;
        expectedWorkflowId = workflowId;
        emit ExpectedWorkflowUpdated(workflowOwner, workflowId);
    }

    /// @inheritdoc IMeridianKeeperReceiver
    /// @dev Simulation: the network's MockKeystoneForwarder. Production: the KeystoneForwarder (Forwarder Directory).
    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Owner: withdraw the receiver's margin from `clearingHouse` and send it to `to`. Reverts as
    ///         ClearingHouse.withdraw does (InsufficientMargin while it holds an inherited position).
    function withdrawMargin(address clearingHouse, uint256 amountToken, address to) external onlyOwner nonReentrant {
        IClearingHouse(clearingHouse).withdraw(amountToken);
        IERC20(IClearingHouse(clearingHouse).collateralToken()).safeTransfer(to, amountToken);
    }

    /// @notice Owner: recover ERC-20s sent here.
    function sweepToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Owner: recover MON held for oracle fees.
    function sweepNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        SafeTransferLib.safeTransferETH(to, amount);
    }

    // ─── internal ──────────────────────────────────────────────────────────────

    /// @dev Calls `target` without bubbling a revert; a target with no code counts as a failure (a high-level call
    ///      to an EOA would revert on the empty return data, outside try/catch).
    function _call(address target, bytes memory data) internal returns (bool ok) {
        if (target.code.length == 0) return false;
        (ok,) = target.call(data);
    }
}
