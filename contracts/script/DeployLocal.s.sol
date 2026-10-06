// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../src/mocks/MockOracleAdapter.sol";
import {MockMeridianVault} from "../src/mocks/MockMeridianVault.sol";
import {MockKuruHedger} from "../src/mocks/MockKuruHedger.sol";
import {InsuranceFund} from "../src/clearing/InsuranceFund.sol";
import {ClearingHouse} from "../src/clearing/ClearingHouse.sol";
import {MarketFactory} from "../src/clearing/MarketFactory.sol";
import {OrderBook} from "../src/orderbook/OrderBook.sol";

/// @notice Local (anvil, chain 31337) stack. Writes `deployments/31337.json` (same keys as before, so the TS
///         consumers don't change). Phase 2: the perp core is REAL (OrderBook, ClearingHouse, InsuranceFund,
///         MarketFactory) with MATH_SPEC defaults from `script/config/31337.json`. Still mocks: the oracle
///         (MockOracleAdapter, MON = 0.029, settable), tAUSD (6 dp) and WMON, and the vault/hedger (WS-04 not merged).
///   anvil &
///   forge script script/DeployLocal.s.sol --fork-url http://localhost:8545 --broadcast
/// @dev DEPLOYER_PK defaults to anvil's public account #0 key; local only (the script refuses other chains).
///      Deterministic addresses on a fresh anvil (deployer nonce 0..).
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
        address marketFactory;
        address vault;
        address hedger;
    }

    Deployed internal d;

    function run() external returns (Deployed memory) {
        require(block.chainid == 31_337, "DeployLocal: anvil only");
        _loadConfig();
        uint256 pk = vm.envOr("DEPLOYER_PK", ANVIL_PK0);
        address owner = vm.addr(pk);
        uint256 startBlock = block.number;
        vm.startBroadcast(pk);
        _deployPerp(owner);
        _deployVault();
        MockERC20(d.ausd).mint(owner, _u(".local.faucetAusdToken"));
        vm.stopBroadcast();
        _write(startBlock);
        return d;
    }

    function _deployPerp(address owner) internal {
        d.ausd = address(new MockERC20("Test AUSD", "tAUSD", 6));
        d.wmon = address(new MockERC20("Wrapped MON (mock)", "WMON", 18));
        d.oracle = address(new MockOracleAdapter(_u(".local.initialIndexPriceWad")));
        InsuranceFund fund = new InsuranceFund(d.ausd, owner);
        ClearingHouse ch = new ClearingHouse(d.ausd, d.oracle, address(fund), _riskParams(), _fundingParams(), owner);
        OrderBook ob = new OrderBook(address(ch), _u(".params.perp.tickSizeWad"), _u(".params.perp.lotSizeWad"));
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        MarketFactory factory = new MarketFactory(owner);
        factory.registerMarket(cfg.readString(".params.perp.symbol"), address(ob), address(ch), d.oracle, d.wmon);
        d.insuranceFund = address(fund);
        d.clearingHouse = address(ch);
        d.orderBook = address(ob);
        d.marketFactory = address(factory);
    }

    function _deployVault() internal {
        d.vault = address(new MockMeridianVault(d.ausd));
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
        c.serialize("MarketFactory", d.marketFactory);
        c.serialize("MeridianVault", d.vault);
        string memory contracts = c.serialize("KuruHedger", d.hedger);

        string[] memory mocks = new string[](5);
        (mocks[0], mocks[1], mocks[2], mocks[3], mocks[4]) =
        ("AUSD", "WMON", "OracleAdapter", "MeridianVault", "KuruHedger");

        string memory root = "root";
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
        root.serialize("mocks", false);
        root.serialize("mockContracts", mocks);
        root.serialize(
            "_note",
            string(
                "Phase 2: real OrderBook + ClearingHouse + InsuranceFund + MarketFactory; mock oracle (settable), tAUSD (6 dp), WMON, vault, hedger"
            )
        );
        string memory out = root.serialize("contracts", contracts);
        out.write(_deploymentsPath());
    }
}
