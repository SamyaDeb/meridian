// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../src/mocks/MockOracleAdapter.sol";
import {MockInsuranceFund} from "../src/mocks/MockInsuranceFund.sol";
import {MockClearingHouse} from "../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../src/mocks/MockOrderBook.sol";
import {MockPulseVault} from "../src/mocks/MockPulseVault.sol";
import {MockKuruHedger} from "../src/mocks/MockKuruHedger.sol";

/// @notice Local (anvil, chain 31337) stack for WS-03/06/07 development. Writes `deployments/31337.json`.
///         Day 1: everything is a mock. As WS-01/02/05 merge, their real contracts replace the mocks here
///         (same JSON keys, so TS consumers don't change).
///   anvil &
///   forge script script/DeployLocal.s.sol --fork-url http://localhost:8545 --broadcast
/// @dev DEPLOYER_PK defaults to anvil's public account #0 key; local only (the script refuses other chains).
contract DeployLocal is DeployBase {
    using stdJson for string;

    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    struct Deployed {
        address ausd;
        address wmon;
        address oracle;
        address insuranceFund;
        address clearingHouse;
        address orderBook;
        address vault;
        address hedger;
    }

    Deployed internal d;

    function run() external returns (Deployed memory) {
        require(block.chainid == 31_337, "DeployLocal: anvil only");
        _loadConfig();
        uint256 pk = vm.envOr("DEPLOYER_PK", ANVIL_PK0);
        uint256 startBlock = block.number;
        vm.startBroadcast(pk);
        _deployPerp();
        _deployVault();
        MockERC20(d.ausd).mint(vm.addr(pk), _u(".local.faucetAusdToken"));
        vm.stopBroadcast();
        _write(startBlock);
        return d;
    }

    function _deployPerp() internal {
        uint256 index = _u(".local.initialIndexPriceWad");
        uint256 tickSize = _u(".params.perp.tickSizeWad");
        d.ausd = address(new MockERC20("Agora USD (mock)", "AUSD", 6));
        d.wmon = address(new MockERC20("Wrapped MON (mock)", "WMON", 18));
        d.oracle = address(new MockOracleAdapter(index));
        d.insuranceFund = address(new MockInsuranceFund(d.ausd));
        MockClearingHouse ch = new MockClearingHouse(d.ausd, d.oracle, d.insuranceFund);
        MockOrderBook ob = new MockOrderBook(address(ch), tickSize, _u(".params.perp.lotSizeWad"));
        ch.setOrderBook(address(ob));
        ch.setRiskParams(_riskParams());
        ch.setFundingParams(_fundingParams());
        MockInsuranceFund(d.insuranceFund).setMarketAuthorized(address(ch), true);
        // Synthetic book around the index so the app has a mid, a spread and a fill price.
        uint32 midTick = uint32(index / tickSize);
        ob.mockSetBook(midTick - 1, midTick + 1);
        ob.mockSetFillPrice(uint256(midTick) * tickSize);
        d.clearingHouse = address(ch);
        d.orderBook = address(ob);
    }

    function _deployVault() internal {
        d.vault = address(new MockPulseVault(d.ausd));
        d.hedger = address(new MockKuruHedger(d.wmon, d.ausd, _u(".local.initialIndexPriceWad")));
    }

    function _write(uint256 startBlock) internal {
        string memory c = "contracts";
        c.serialize("AUSD", d.ausd);
        c.serialize("WMON", d.wmon);
        c.serialize("OracleAdapter", d.oracle);
        c.serialize("InsuranceFund", d.insuranceFund);
        c.serialize("ClearingHouse", d.clearingHouse);
        c.serialize("OrderBook", d.orderBook);
        c.serialize("PulseVault", d.vault);
        string memory contracts = c.serialize("KuruHedger", d.hedger);

        string memory root = "root";
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
        root.serialize("mocks", true);
        root.serialize("_note", string("Day-1 mock stack; keys stay stable as real contracts replace mocks"));
        string memory out = root.serialize("contracts", contracts);
        out.write(_deploymentsPath());
    }
}
