// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";

interface IAUSD {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function allowance(address, address) external view returns (uint256);
}

contract AusdPermitTest is Test {
    function test_permit() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string("")); // fork tests run only with MONAD_RPC_URL
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        IAUSD a = IAUSD(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
        (address owner, uint256 pk) = makeAddrAndKey("owner");
        address spender = address(0xBEEF);
        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                a.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, 123e6, a.nonces(owner), dl))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        a.permit(owner, spender, 123e6, dl, v, r, s);
        assertEq(a.allowance(owner, spender), 123e6);
    }
}
