// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PulseConstants} from "../../../src/interfaces/PulseTypes.sol";

/// @notice Reference model of the funding-swap ledger (MATH_SPEC §6.2), used by the invariant suite until
///         WS-05's FundingSwapMarket lands. The driver swaps this for the real market then; the invariants
///         (I9) stay the same.
/// @dev Two rounding choices the model makes explicit (reported to WS-05):
///      - K is updated with one truncated kDelta applied +/− to both sides, so ΣK == 0 exactly
///        (flooring each side separately would leak 1 wei per fill).
///      - net is ONE floor division of (q·ΔF·YEAR − K·ΔG)/(1e18·YEAR), so Σnet ∈ [−#settlements, 0]
///        (rounding each leg separately widens the bound to −2·#settlements).
contract SwapLedgerModel {
    int256 internal constant W = PulseConstants.IWAD;
    int256 internal constant YEAR = int256(PulseConstants.SECONDS_PER_YEAR);

    struct Account {
        int256 q; // MON notional, WAD (+ long = receive floating, pay fixed)
        int256 k; // fixedAprNotional, WAD: K += Δq·A/1e18
        int256 f0; // perp F at last settle
        int256 g0; // perp G at last settle
    }

    int256 public cumFunding; // F (mirrors the perp market)
    int256 public cumIndexTime; // G
    bool public matured;
    mapping(address => Account) public accounts;

    /// @notice Mirrors the perp indices; accrual stops at maturity (settleMaturity snapshot).
    function accrue(int256 dF, int256 dG) external {
        if (matured) return;
        cumFunding += dF;
        cumIndexTime += dG;
    }

    function settleMaturity() external {
        matured = true;
    }

    /// @notice Unsettled net for `a` at the current indices: floor((q·ΔF·YEAR − K·ΔG)/(1e18·YEAR)). Rounds down.
    function pendingNet(address a) public view returns (int256) {
        Account memory x = accounts[a];
        int256 num = x.q * (cumFunding - x.f0) * YEAR - x.k * (cumIndexTime - x.g0);
        return _divFloor(num, W * YEAR); // MATH_SPEC §6.2, rounds down
    }

    /// @return net credited to `a` (+ = received)
    function settle(address a) public returns (int256 net) {
        net = pendingNet(a);
        Account storage x = accounts[a];
        x.f0 = cumFunding;
        x.g0 = cumIndexTime;
    }

    /// @notice One fill: `buyer` goes long `size` at fixed APR `aprWad` against `seller`. Settle first, then update.
    /// @return netBuyer settled net of the buyer
    /// @return netSeller settled net of the seller
    function fill(address buyer, address seller, int256 size, int256 aprWad)
        external
        returns (int256 netBuyer, int256 netSeller)
    {
        require(!matured && buyer != seller && size > 0, "model: bad fill");
        netBuyer = settle(buyer);
        netSeller = settle(seller);
        int256 kDelta = size * aprWad / W; // MATH_SPEC §6.2, rounds neutral (toward zero), applied ± ⇒ ΣK == 0
        accounts[buyer].q += size;
        accounts[buyer].k += kDelta;
        accounts[seller].q -= size;
        accounts[seller].k -= kDelta;
    }

    function _divFloor(int256 n, int256 d) internal pure returns (int256 q) {
        q = n / d;
        if (n % d != 0 && (n < 0) != (d < 0)) q -= 1;
    }
}
