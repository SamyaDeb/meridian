// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MeridianKeeperReceiver} from "../src/automation/MeridianKeeperReceiver.sol";
import {MeridianMfiFeed} from "../src/oracle/MeridianMfiFeed.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {MeridianVault} from "../src/vault/MeridianVault.sol";

/// @notice K4 (PHASES decision 43): attach the Chainlink CRE backstop keeper `MeridianKeeperReceiver` to an EXISTING
///         deployment record. Standalone: no existing contract changes. Steps:
///         1. deploy the receiver with the config's CRE forwarder: `cre.keystoneForwarderSim` (the MockKeystoneForwarder
///            that `cre workflow simulate --broadcast` writes through, default) or `cre.keystoneForwarder`
///            (production DON delivery) with CRE_FORWARDER_MODE=prod; owner = the record's owner;
///         2. fund its liquidation margin with `depositFor` in the main and (testnet) the demo ClearingHouse:
///            RECEIVER_MARGIN (AUSD token units, default 200e6 each). Testnet mints the mock tAUSD; 143 never mints;
///         3. vault.setKeeper(receiver, true) when the deployer owns the vault (testnet), else print the owner tx;
///         4. (CR-016) deploy `MeridianMfiFeed(receiver)`: the onchain MFI, written by receiver action 6.
///         Record: `contracts.MeridianKeeperReceiver`, `contracts.MeridianMfiFeed`, `creForwarder`, `creForwarderMode`,
///         `receiverStartBlock`.
///   Dry-run: DEPLOYER_PK=… forge script script/DeployKeeperReceiver.s.sol --fork-url $MONAD_TESTNET_RPC_URL
///            (writes deployments/dry-run/keeper-receiver-<chainid>.json, labelled SIMULATION)
///   Deploy:  … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow
contract DeployKeeperReceiver is DeployBase {
    using stdJson for string;

    uint256 internal constant MAINNET = 143;

    struct Out {
        address receiver;
        address mfiFeed;
        address forwarder;
        string mode;
        uint256 marginMain;
        uint256 marginDemo;
        bool vaultKeeperSet;
        uint256 startBlock;
    }

    function run() external returns (Out memory o) {
        _loadConfig();
        string memory inName = vm.envOr("DEPLOYMENTS_FILE", string.concat(vm.toString(block.chainid), ".json"));
        string memory rec = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", inName));
        require(rec.readUint(".chainId") == block.chainid, "record is for another chain");

        o.mode = vm.envOr("CRE_FORWARDER_MODE", string("sim"));
        bool prod = keccak256(bytes(o.mode)) == keccak256("prod");
        require(prod || keccak256(bytes(o.mode)) == keccak256("sim"), "CRE_FORWARDER_MODE: sim | prod");
        o.forwarder = _optAddress(prod ? ".cre.keystoneForwarder" : ".cre.keystoneForwarderSim");
        require(o.forwarder != address(0) && o.forwarder.code.length > 0, "forwarder: config address without code");

        address owner = rec.readAddress(".owner");
        address ch = rec.readAddress(".contracts.ClearingHouse");
        address demoCh =
            vm.keyExistsJson(rec, ".demoMarket") ? rec.readAddress(".demoMarket.ClearingHouse") : address(0);
        address vault = vm.keyExistsJson(rec, ".contracts.MeridianVault")
            ? rec.readAddress(".contracts.MeridianVault")
            : address(0);
        uint256 margin = vm.envOr("RECEIVER_MARGIN", uint256(200e6));
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);

        o.startBlock = block.number;
        vm.startBroadcast(pk);
        o.receiver = address(new MeridianKeeperReceiver(o.forwarder, owner));
        o.mfiFeed = address(new MeridianMfiFeed(o.receiver));
        if (margin != 0) {
            o.marginMain = _fund(ch, o.receiver, margin, deployer);
            if (demoCh != address(0)) o.marginDemo = _fund(demoCh, o.receiver, margin, deployer);
        }
        if (vault != address(0) && Ownable(vault).owner() == deployer) {
            MeridianVault(vault).setKeeper(o.receiver, true);
            o.vaultKeeperSet = true;
        }
        vm.stopBroadcast();

        require(Ownable(o.receiver).owner() == owner, "receiver owner");
        require(MeridianKeeperReceiver(payable(o.receiver)).forwarder() == o.forwarder, "receiver forwarder");
        require(MeridianMfiFeed(o.mfiFeed).receiver() == o.receiver, "feed receiver");
        _write(rec, o);
        _log(o, vault);
    }

    /// @dev depositFor(receiver, amount) from the deployer; testnet mints the mock collateral first.
    function _fund(address ch, address receiver, uint256 amount, address deployer) internal returns (uint256) {
        IERC20 ausd = IERC20(IClearingHouse(ch).collateralToken());
        if (ausd.balanceOf(deployer) < amount) {
            require(block.chainid != MAINNET, "143: the deployer must hold the receiver's AUSD margin");
            MockERC20(address(ausd)).mint(deployer, amount - ausd.balanceOf(deployer));
        }
        ausd.approve(ch, amount);
        IClearingHouse(ch).depositFor(receiver, amount);
        return amount;
    }

    function _write(string memory rec, Out memory o) internal {
        // a simulation never touches the real record unless DEPLOYMENTS_OUT says so
        string memory path = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.envExists("DEPLOYMENTS_OUT")
            ? _deploymentsPath()
            : string.concat(
                vm.projectRoot(), "/../deployments/dry-run/keeper-receiver-", vm.toString(block.chainid), ".json"
            );
        if (!vm.exists(path) || keccak256(bytes(vm.readFile(path))) != keccak256(bytes(rec))) vm.writeFile(path, rec);
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson('"SIMULATION (forge script without --broadcast): addresses are not deployed"', path, "._label");
        }
        vm.writeJson(vm.toString(o.receiver), path, ".contracts.MeridianKeeperReceiver");
        vm.writeJson(vm.toString(o.mfiFeed), path, ".contracts.MeridianMfiFeed");
        vm.writeJson(vm.toString(o.forwarder), path, ".creForwarder");
        vm.writeJson(string.concat('"', o.mode, '"'), path, ".creForwarderMode");
        vm.writeJson(vm.toString(o.startBlock), path, ".receiverStartBlock");
    }

    function _log(Out memory o, address vault) internal pure {
        console.log("MeridianKeeperReceiver", o.receiver);
        console.log("MeridianMfiFeed", o.mfiFeed);
        console.log("forwarder", o.forwarder, o.mode);
        console.log("margin main / demo (AUSD units)", o.marginMain, o.marginDemo);
        if (vault == address(0)) {
            console.log("no vault in the record: VAULT_REBALANCE reports will fail until one is attached");
        } else if (o.vaultKeeperSet) {
            console.log("vault.setKeeper(receiver, true) done");
        } else {
            console.log("OWNER TX STILL NEEDED: vault.setKeeper(receiver, true) on", vault);
        }
        console.log("production switch (owner): setForwarder(cre.keystoneForwarder) + setExpectedWorkflow(owner, id)");
    }
}
