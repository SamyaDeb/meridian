// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockKuruHedger} from "../src/mocks/MockKuruHedger.sol";
import {KuruHedger} from "../src/vault/KuruHedger.sol";
import {MeridianVault} from "../src/vault/MeridianVault.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";

/// @notice Vault v2 (CR-014, HARDENING_PLAN P5.3i / P6.1): attach a new KuruHedger + MeridianVault to an EXISTING
///         deployment record (`deployments/<DEPLOYMENTS_FILE>`, default `<chainid>.json`). The perp ClearingHouse /
///         OrderBook / swaps / demo market are not touched. The record gains `contracts.MeridianVault`,
///         `contracts.KuruHedger`, `vaultStartBlock` and (testnet) `mockContracts` += "KuruHedger"; every other key
///         (operator lists, demo market, swaps) is kept as is (vm.writeJson on single keys).
///         - Hedger: real KuruHedger when `kuru.flowEntrypoint` is set, ALWAYS with `kuruMarket = address(0)` (Flow
///           routes only: the configured direct MON/AUSD market is dead on 143, ARCHITECTURE R19, so an empty route
///           must fail loudly). Without a Flow entrypoint (10143) a clearly labelled MockKuruHedger over a mock
///           "tWMON" priced at the oracle index; refused on 143.
///         - Params: `_vaultV2DeployParams()` = config with skewCapacity 0 and depositCap 1,200 AUSD (hedge off at
///           deploy; the owner enables it later).
///         - Roles: KEEPER_ADDRESS (required) is the vault keeper; MM_ADDRESS (optional) the skew provider; on 143 neither
///           may be the deployer. Ownership → config `owner` (143: the Safe) when it isn't the deployer.
///   Dry-run: DEPLOYER_PK=… KEEPER_ADDRESS=… MM_ADDRESS=… forge script script/DeployVaultV2.s.sol \
///            --fork-url $MONAD_TESTNET_RPC_URL     (writes deployments/dry-run/vault-v2-<chainid>.json, labelled)
///   Deploy (P6, testnet only): … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow
contract DeployVaultV2 is DeployBase {
    using stdJson for string;

    uint256 internal constant MAINNET = 143;

    struct Out {
        address hedger;
        address vault;
        address spotToken; // testnet mock tWMON (0 with a real hedger)
        bool hedgerIsMock;
        uint256 startBlock;
    }

    struct In {
        address ausd;
        address wmon;
        address ch;
        address ob;
        address oracle;
        address deployer;
        address keeper;
        address mm;
        address owner;
        address flowEntry;
    }

    In internal a;

    function run() external returns (Out memory o) {
        _loadConfig();
        string memory inName = vm.envOr("DEPLOYMENTS_FILE", string.concat(vm.toString(block.chainid), ".json"));
        string memory rec = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", inName));
        require(rec.readUint(".chainId") == block.chainid, "record is for another chain");
        _inputs(rec);
        uint256 pk = vm.envUint("DEPLOYER_PK");
        require(vm.addr(pk) == a.deployer, "DEPLOYER_PK");
        o.startBlock = block.number;
        vm.startBroadcast(pk);
        _deploy(o);
        vm.stopBroadcast();
        MeridianVault v = MeridianVault(o.vault);
        require(Ownable(o.vault).owner() == a.owner, "vault owner");
        require(!v.isKeeper(a.deployer) || a.deployer == a.keeper, "deployer holds no vault role");
        _write(rec, o);
        _log(o);
    }

    function _inputs(string memory rec) internal {
        a.ausd = rec.readAddress(".contracts.AUSD");
        a.wmon = rec.readAddress(".contracts.WMON");
        a.ch = rec.readAddress(".contracts.ClearingHouse");
        a.ob = rec.readAddress(".contracts.OrderBook");
        a.oracle = rec.readAddress(".contracts.OracleAdapter");
        require(a.ch.code.length != 0, "ClearingHouse has no code on this chain");
        require(
            IClearingHouse(a.ch).orderBook() == a.ob && IClearingHouse(a.ch).collateralToken() == a.ausd,
            "record wiring"
        );
        a.deployer = vm.addr(vm.envUint("DEPLOYER_PK"));
        a.keeper = vm.envAddress("KEEPER_ADDRESS");
        a.mm = vm.envOr("MM_ADDRESS", address(0));
        require(a.keeper != address(0), "set KEEPER_ADDRESS");
        a.owner = _optAddress(".owner");
        if (a.owner == address(0)) {
            require(cfg.readBoolOr(".ownerIsDeployer", false), "VERIFY: owner missing in config");
            require(block.chainid != MAINNET, "mainnet owner must be the Safe 2-of-3");
            a.owner = a.deployer;
        }
        if (block.chainid == MAINNET) {
            require(a.keeper != a.deployer && a.mm != a.deployer, "mainnet vault: keeper/MM must not be the deployer");
            // PHASES 40: no mainnet broadcast. ALLOW_FORK_BROADCAST_143 is set only by script/fork/rehearse-vault-v2.sh,
            // which refuses anything but a localhost anvil fork.
            require(
                !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.envOr("ALLOW_FORK_BROADCAST_143", false),
                "no mainnet broadcast before the hackathon (PHASES 40)"
            );
        }
        a.flowEntry = _optAddress(".kuru.flowEntrypoint");
    }

    function _deploy(Out memory o) internal {
        if (a.flowEntry == address(0)) {
            require(block.chainid != MAINNET, "VERIFY: kuru.flowEntrypoint for mainnet");
            o.spotToken = address(new MockERC20("TEST Wrapped MON (vault mock)", "tWMON", 18));
            (bool ok, uint256 px,) = IOracleAdapter(a.oracle).tryGetIndexPrice();
            o.hedger = address(new MockKuruHedger(o.spotToken, a.ausd, ok ? px : 0.029e18));
            o.hedgerIsMock = true;
        } else {
            // kuruMarket = address(0): Flow routes only (P5.2), whatever `kuru.monAusdMarket` says
            o.hedger = address(new KuruHedger(a.deployer, a.wmon, a.ausd, a.flowEntry, address(0)));
        }
        MeridianVault v = new MeridianVault(IERC20(a.ausd), a.ch, a.ob, o.hedger, _vaultV2DeployParams(), a.deployer);
        o.vault = address(v);
        if (!o.hedgerIsMock) KuruHedger(payable(o.hedger)).setVault(o.vault);
        v.setKeeper(a.keeper, true);
        if (a.mm != address(0)) v.setSkewProvider(a.mm, true);
        if (a.owner != a.deployer) {
            v.transferOwnership(a.owner);
            if (!o.hedgerIsMock) KuruHedger(payable(o.hedger)).transferOwnership(a.owner);
        }
    }

    function _write(string memory rec, Out memory o) internal {
        // a simulation never touches the real record unless DEPLOYMENTS_OUT says so
        string memory path = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.envExists("DEPLOYMENTS_OUT")
            ? _deploymentsPath()
            : string.concat(vm.projectRoot(), "/../deployments/dry-run/vault-v2-", vm.toString(block.chainid), ".json");
        if (!vm.exists(path) || keccak256(bytes(vm.readFile(path))) != keccak256(bytes(rec))) vm.writeFile(path, rec);
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson('"SIMULATION (forge script without --broadcast): addresses are not deployed"', path, "._label");
        }
        vm.writeJson(vm.toString(o.vault), path, ".contracts.MeridianVault");
        vm.writeJson(vm.toString(o.hedger), path, ".contracts.KuruHedger");
        vm.writeJson(vm.toString(o.startBlock), path, ".vaultStartBlock");
        vm.writeJson('"2 (CR-014: async withdrawals, interfaces-v1.7)"', path, ".vaultVersion");
        if (!o.hedgerIsMock) return;
        vm.writeJson(vm.toString(o.spotToken), path, ".vaultMockSpotToken");
        // mockContracts += "KuruHedger" (kept unique)
        string[] memory mocks = rec.readStringArray(".mockContracts");
        string memory arr = "[";
        bool has;
        for (uint256 i; i < mocks.length; ++i) {
            if (keccak256(bytes(mocks[i])) == keccak256("KuruHedger")) has = true;
            arr = string.concat(arr, i == 0 ? "" : ",", '"', mocks[i], '"');
        }
        if (!has) arr = string.concat(arr, mocks.length == 0 ? "" : ",", '"KuruHedger"');
        vm.writeJson(string.concat(arr, "]"), path, ".mockContracts");
    }

    function _log(Out memory o) internal view {
        console.log("KuruHedger", o.hedger, o.hedgerIsMock ? "(LABELLED MOCK: MockKuruHedger, tWMON)" : "(Flow only)");
        console.log("MeridianVault", o.vault);
        console.log("owner / keeper / MM", a.owner, a.keeper, a.mm);
        console.log("vaultStartBlock", o.startBlock);
    }
}
