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
import {MeridianConstants, RiskParams, Position, AccountView} from "../interfaces/MeridianTypes.sol";

/// @title MeridianKeeperReceiver — Chainlink CRE backstop keeper for Meridian
/// @notice A CRE workflow's DON-signed report reaches `onReport` through the Chainlink KeystoneForwarder. The report
///         is `abi.encode(uint8 action, bytes payload)` (IMeridianKeeperReceiver): 1 VAULT_REBALANCE, 2 LIQUIDATE,
///         3 FUNDING_POKE, 4 ORACLE_UPDATE (mainnet / Pyth only). Every external call is isolated: one failing account
///         or market never reverts the report, `ReportExecuted.success` is true only if every item succeeded.
/// @dev LIQUIDATE makes this contract the liquidator: it must hold margin in that ClearingHouse (`depositFor`) and it
///      inherits the positions it takes. Each take is sized to the receiver's own cap and IM headroom (same rule as
///      keepers/ts-fallback/src/unwind.ts `liquidationHeadroom`), so a take never reverts on the receiver's limits.
///      Only `forwarder` may call `onReport`: with the simulation MockKeystoneForwarder that is the whole gate (the mock
///      carries no workflow owner / name); workflow identity checks come with CR-016.
contract MeridianKeeperReceiver is IMeridianKeeperReceiver, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint8 public constant VAULT_REBALANCE = 1;
    uint8 public constant LIQUIDATE = 2;
    uint8 public constant FUNDING_POKE = 3;
    uint8 public constant ORACLE_UPDATE = 4;
    /// @notice Safety margin on the receiver's IM capacity (mark drift, IM rounding): 2%, as the TS keeper.
    uint256 public constant HEADROOM_BUFFER_BPS = 200;

    /// @inheritdoc IMeridianKeeperReceiver
    address public forwarder;

    constructor(address forwarder_, address owner_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderUpdated(forwarder_);
    }

    /// @notice Pays Pyth update fees (ORACLE_UPDATE) and receives the oracle's fee refunds.
    receive() external payable {}

    // ─── IReceiver ─────────────────────────────────────────────────────────────

    /// @inheritdoc IMeridianKeeperReceiver
    /// @dev `metadata` is 64 bytes from the production forwarder (workflowId ‖ name ‖ owner ‖ reportId) and may be
    ///      shorter from the simulation forwarder: the workflowId is its first 32 bytes, else 0. No length check.
    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (msg.sender != forwarder) revert OnlyForwarder();
        (uint8 action, bytes memory payload) = abi.decode(report, (uint8, bytes));
        bool success;
        if (action == LIQUIDATE) success = _liquidate(payload);
        else if (action == FUNDING_POKE) success = _fundingPoke(payload);
        else if (action == VAULT_REBALANCE) success = _vaultRebalance(payload);
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

    // ─── Admin ─────────────────────────────────────────────────────────────────

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
