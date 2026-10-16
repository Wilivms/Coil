// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

/// The app signs with viem's `signTypedData`. These digests were produced by viem
/// (app/src/lib/signing.ts field order) and must equal what MUSD's BorrowerOperationsSignatures
/// computes: keccak256(abi.encodePacked(typeHash, abi.encode(fields), nonce, deadline)) under
/// OZ EIP712("BorrowerOperationsSignatures", "1").
contract SignatureCompatTest is Test {
    address constant BOS = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address constant U = 0x1111111111111111111111111111111111111111;
    address constant R = 0x2222222222222222222222222222222222222222;
    uint256 constant DEADLINE = 1792150000;

    function _digest(bytes32 typeHash, bytes memory data, uint256 nonce) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                uint256(31611),
                BOS
            )
        );
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, nonce, DEADLINE));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function test_openTroveDigestMatchesViem() public pure {
        bytes32 th = keccak256(
            "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
        );
        assertEq(
            _digest(th, abi.encode(uint256(3e18), uint256(165_000e18), U, R), 4),
            0xfad0d703634c34e16a6d0d10f9fd5b8dbac2d3bdf6964aca3ba0e3c0e9001b1e
        );
    }

    function test_adjustTroveDigestMatchesViem() public pure {
        bytes32 th = keccak256(
            "AdjustTrove(uint256 collWithdrawal,uint256 debtChange,bool isDebtIncrease,uint256 assetAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
        );
        assertEq(
            _digest(th, abi.encode(uint256(1e17), uint256(8000e18), false, uint256(0), U, R), 5),
            0x078d1f51f1e572a0ce913cfbd8b96bf1677bed3be6ac3751d2d263948e0444eb
        );
    }

    function test_closeTroveDigestMatchesViem() public pure {
        bytes32 th = keccak256("CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)");
        assertEq(
            _digest(th, abi.encode(U, R), 6), 0xd8efd638ff917b68922334a5fdf51f790d59a41a4509297c363f8f0e59105b29
        );
    }
}
