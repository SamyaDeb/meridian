// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {IMarketFactory} from "../src/interfaces/IMarketFactory.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";

/// @notice Full Pulse deployment (testnet 10143 / mainnet 143), ARCHITECTURE §7 order. SKELETON (WS-00):
///         implementations are deployed by artifact name (`deployCode`) so this compiles before WS-01/02/03/04/05
///         merge. Each step marked TODO(WS-xx) is finished by that workstream; WS-08 runs the Day-11 fork rehearsal.
///   forge script script/DeployPulse.s.sol --rpc-url $MONAD_RPC_URL --broadcast   (DEPLOYER_PK from .env)
/// @dev Constructor shapes for A's contracts (WS-01/02/05) are the ones those workstreams implement:
///        InsuranceFund(asset, owner) · ClearingHouse(collateral, oracle, insuranceFund, RiskParams, FundingParams, owner)
///        OrderBook(engine, tickSize, lotSize) · MarketFactory(owner)
///        FundingSwapMarket(perpClearingHouse, collateral, insuranceFund, maturity, SwapParams, owner)
///      The deployer is the initial owner; ownership moves to the Safe 2-of-3 at the end (Ownable2Step: Safe accepts).
contract DeployPulse is DeployBase {
    using stdJson for string;

    struct Deployed {
        address insuranceFund;
        address oracle;
        address clearingHouse;
        address orderBook;
        address marketFactory;
        address hedger;
        address vault;
        address swapMarket;
        address swapOrderBook;
        address keeperReceiver;
    }

    Deployed internal d;
    address internal ausd;
    address internal wmon;
    address internal owner;

    function run() external returns (Deployed memory) {
        _loadConfig();
        ausd = cfg.readAddress(".tokens.AUSD");
        wmon = cfg.readAddress(".tokens.WMON");
        owner = cfg.readAddressOr(".owner", address(0));
        require(ausd != address(0) && wmon != address(0), "VERIFY: tokens missing in config");
        require(owner != address(0), "VERIFY: owner (Safe 2-of-3) missing in config");

        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint256 startBlock = block.number;
        vm.startBroadcast(pk);
        _deployPerp(vm.addr(pk));
        _deployVault();
        _deploySwaps(vm.addr(pk));
        _handOver();
        vm.stopBroadcast();
        _write(startBlock);
        return d;
    }

    /// @dev Steps 1–7.
    function _deployPerp(address deployer) internal {
        // 1. InsuranceFund
        d.insuranceFund = deployCode("InsuranceFund.sol:InsuranceFund", abi.encode(ausd, deployer));
        // 2. OracleAdapter (MON/USD). TODO(WS-03): confirm constructor args with PythChainlinkOracleAdapter.
        d.oracle = deployCode(
            "PythChainlinkOracleAdapter.sol:PythChainlinkOracleAdapter",
            abi.encode(
                cfg.readAddress(".pyth.contract"),
                cfg.readBytes32(".pyth.monUsdFeedId"),
                cfg.readAddress(".chainlink.monUsd"),
                cfg.readUint(".params.oracle.maxStalenessSec"),
                cfg.readUint(".params.oracle.chainlinkGuardStalenessSec"),
                cfg.readUint(".params.oracle.maxDeviationWad"), // VERIFY: null in config until WS-03 picks it
                deployer
            )
        );
        // 3. ClearingHouse
        d.clearingHouse = deployCode(
            "ClearingHouse.sol:ClearingHouse",
            abi.encode(ausd, d.oracle, d.insuranceFund, _riskParams(), _fundingParams(), deployer)
        );
        // 4. OrderBook (perp)
        d.orderBook = deployCode(
            "OrderBook.sol:OrderBook",
            abi.encode(d.clearingHouse, _u(".params.perp.tickSizeWad"), _u(".params.perp.lotSizeWad"))
        );
        // 5–6. wiring
        IClearingHouse(d.clearingHouse).setOrderBook(d.orderBook);
        IInsuranceFund(d.insuranceFund).setMarketAuthorized(d.clearingHouse, true);
        // 7. registry
        d.marketFactory = deployCode("MarketFactory.sol:MarketFactory", abi.encode(deployer));
        IMarketFactory(d.marketFactory)
            .registerMarket(cfg.readString(".params.perp.symbol"), d.orderBook, d.clearingHouse, d.oracle, wmon);
    }

    /// @dev Steps 8–9. TODO(WS-04): constructor args for KuruHedger (CR-002: Kuru Flow entrypoint) and PulseVault,
    ///      then `setVaultParams(_vaultParams())` and `setKeeper(keeper, true)`.
    function _deployVault() internal {
        d.hedger = deployCode(
            "KuruHedger.sol:KuruHedger",
            abi.encode(wmon, ausd, cfg.readAddress(".kuru.flowEntrypoint"), cfg.readAddress(".kuru.monAusdMarket"))
        );
        d.vault = deployCode("PulseVault.sol:PulseVault", abi.encode(ausd, d.clearingHouse, d.orderBook, d.hedger));
    }

    /// @dev Steps 10–13.
    function _deploySwaps(address deployer) internal {
        uint256 maturity = cfg.readUintOr(".params.swap.maturity", 0);
        require(maturity > block.timestamp, "VERIFY: set params.swap.maturity (30 d after listing)");
        // 10. FundingSwapMarket
        d.swapMarket = deployCode(
            "FundingSwapMarket.sol:FundingSwapMarket",
            abi.encode(d.clearingHouse, ausd, d.insuranceFund, uint64(maturity), _swapParams(), deployer)
        );
        // 11. OrderBook (swap: price = 1 + APR, tick 1 bp APR, lot 1,000 MON)
        d.swapOrderBook = deployCode(
            "OrderBook.sol:OrderBook",
            abi.encode(d.swapMarket, _u(".params.swap.tickSizeWad"), _u(".params.swap.lotSizeWad"))
        );
        // 12. wiring
        IFundingSwapMarket(d.swapMarket).setOrderBook(d.swapOrderBook);
        IInsuranceFund(d.insuranceFund).setMarketAuthorized(d.swapMarket, true);
        // 13. KeeperReceiver (should-tier, only if CRE deploy access). TODO(WS-03).
        if (vm.envOr("DEPLOY_CRE_RECEIVER", false)) {
            d.keeperReceiver = deployCode(
                "PulseKeeperReceiver.sol:PulseKeeperReceiver", abi.encode(cfg.readAddress(".cre.keystoneForwarder"))
            );
        }
    }

    /// @dev Start the Ownable2Step transfer of every owned contract to the Safe; the Safe must `acceptOwnership()`.
    function _handOver() internal {
        address[6] memory owned = [d.insuranceFund, d.oracle, d.clearingHouse, d.marketFactory, d.swapMarket, d.vault];
        for (uint256 i; i < owned.length; ++i) {
            (bool ok,) = owned[i].call(abi.encodeWithSignature("transferOwnership(address)", owner));
            require(ok, "transferOwnership failed");
        }
    }

    function _write(uint256 startBlock) internal {
        string memory c = "contracts";
        c.serialize("AUSD", ausd);
        c.serialize("WMON", wmon);
        c.serialize("InsuranceFund", d.insuranceFund);
        c.serialize("OracleAdapter", d.oracle);
        c.serialize("ClearingHouse", d.clearingHouse);
        c.serialize("OrderBook", d.orderBook);
        c.serialize("MarketFactory", d.marketFactory);
        c.serialize("KuruHedger", d.hedger);
        c.serialize("PulseVault", d.vault);
        c.serialize("FundingSwapMarket", d.swapMarket);
        c.serialize("SwapOrderBook", d.swapOrderBook);
        string memory contracts = c.serialize("PulseKeeperReceiver", d.keeperReceiver);

        string memory root = "root";
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
        root.serialize("mocks", false);
        root.serialize("owner", owner);
        string memory out = root.serialize("contracts", contracts);
        out.write(_deploymentsPath());
    }
}
