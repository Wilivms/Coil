// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CoilRouter} from "../../src/CoilRouter.sol";
import {CoilLens} from "../../src/CoilLens.sol";
import {IBorrowerOperationsSignatures} from "../../src/interfaces/IMezo.sol";
import {MezoAddresses} from "../../script/MezoAddresses.sol";
import {MockBTCPrecompile} from "../mocks/Mocks.sol";
import {ForkAggregator, IApprove, IPoolLike, ITMLike, IBOSNonce} from "./CoilFork.t.sol";

interface IPoolTokens {
    function token0() external view returns (address);
}

/// Coil against the REAL MUSD contracts, sMUSD vault and MUSD/BTC pool of Mezo MAINNET, on a fork.
/// Nothing is deployed or sent on mainnet: this proves the same bytecode is ready for it, and that
/// today's shallow mainnet pool is refused by Coil's own oracle bound instead of costing users.
///
///   cd contracts && forge test --match-path "test/fork/CoilMainnetFork.t.sol" --fork-url mezo_mainnet -vv
///
/// As on testnet, the BTC and Skip-oracle precompiles are replaced by emulators (oracle = the
/// pool's own mid price); every other contract is the live mainnet bytecode and state.
contract CoilMainnetForkTest is Test, MezoAddresses {
    CoilRouter router;
    CoilLens lens;
    Net net;
    address user;
    uint256 userPk;
    uint256 mid; // MUSD per BTC, 1e18

    function setUp() public {
        if (block.chainid != 31612) {
            vm.skip(true);
            return;
        }
        net = mainnet();
        vm.etch(net.btc, address(new MockBTCPrecompile()).code);
        vm.allowCheatcodes(net.btc);

        (uint256 r0, uint256 r1,) = IPoolLike(net.pool).getReserves();
        (uint256 rMusd, uint256 rBtc) = IPoolTokens(net.pool).token0() == net.musd ? (r0, r1) : (r1, r0);
        mid = (rMusd * 1e18) / rBtc;
        vm.etch(SKIP_ORACLE, address(new ForkAggregator(int256(mid))).code);
        ForkAggregator(SKIP_ORACLE).set(int256(mid));

        router = new CoilRouter(
            net.bos, net.troveManager, net.priceFeed, net.sortedTroves, net.savings, net.pool, net.musd, net.btc, address(this)
        );
        lens = new CoilLens(router);
        (user, userPk) = makeAddrAndKey("coil-mainnet-fork-user");
        vm.deal(user, 5e18);
        console2.log("mainnet pool BTC (milli)", rBtc / 1e15);
        console2.log("mainnet pool MUSD", rMusd / 1e18);
        console2.log("pool mid price", mid / 1e18);
    }

    function _sign(bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, IBOSNonce(net.bos).getNonce(user), deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                net.bos
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    bytes32 constant OPEN_TH = keccak256(
        "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );

    /// A plain 250% trove opened straight on mainnet MUSD (no Coil swap), like any Mezo borrower.
    function _openPlainTrove(uint256 debt) internal returns (uint256 coll) {
        coll = (debt * 25e17) / mid;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(OPEN_TH, abi.encode(coll, debt, user, user), deadline);
        vm.prank(user);
        IBorrowerOperationsSignatures(net.bos).openTroveWithSignature{value: coll}(
            debt, address(0), address(0), user, user, sig, deadline
        );
    }

    /// Mainnet's MUSD/BTC pool is too shallow for leverage today. Coil does not take the trade at a
    /// bad price: the PriceFeed bound reverts it. This is the "why not mainnet yet" claim, executed.
    function test_mainnet_coilRefusedOnShallowPool() public {
        uint256 deposit = 0.05e18;
        uint256 totalColl = 0.1e18; // 2x: flash 0.05 BTC out of the pool
        uint256 quote = router.quoteMusdForBtc(totalColl - deposit);
        console2.log("pool asks (MUSD) for 0.05 BTC", quote / 1e18);
        console2.log("fair value at mid (MUSD)", (mid * 5) / 100 / 1e18);
        uint256 debt = (quote * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(OPEN_TH, abi.encode(totalColl, debt, user, address(router)), deadline);
        vm.prank(user);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    /// Reserve in the REAL mainnet sMUSD vault; a Shield repays a REAL mainnet trove through a REAL
    /// RepayMUSD signature. No pool involved: this part of Coil is usable on mainnet as it stands.
    function test_mainnet_reserveAndShieldOnRealMusd() public {
        _openPlainTrove(2_500e18);
        (, uint256 p0, uint256 i0,,,) = ITMLike(net.troveManager).getEntireDebtAndColl(user);

        vm.startPrank(user);
        IApprove(net.musd).approve(address(router), 1_000e18);
        router.depositReserve(1_000e18); // from the MUSD the trove just minted
        vm.stopPrank();
        assertEq(IApprove(net.savings).balanceOf(address(router)), 1_000e18, "reserve sits in mainnet sMUSD");

        uint256 repay = 500e18;
        uint64 deadline = uint64(block.timestamp + 7 days);
        bytes memory sig = _sign(
            keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)"),
            abi.encode(repay, user),
            deadline
        );
        vm.prank(user);
        router.armShield(uint128(repay), uint128((mid * 9) / 10), 0, 2e18, deadline, sig);

        ForkAggregator(SKIP_ORACLE).set(int256((mid * 89) / 100));
        address k = makeAddr("keeper");
        vm.prank(k);
        router.fireShield(user, address(0), address(0), 0);

        (, uint256 p1, uint256 i1,,,) = ITMLike(net.troveManager).getEntireDebtAndColl(user);
        assertEq(p0 + i0 - (p1 + i1), repay, "mainnet trove repaid from the reserve");
        assertEq(IApprove(net.musd).balanceOf(k), 2e18, "keeper bounty");

        uint256 left = router.reserveBalance(user);
        vm.prank(user);
        router.withdrawReserve(left);
        assertEq(IApprove(net.savings).balanceOf(address(router)), 0, "reserve fully withdrawn");
    }

    /// The Shield's redemption trigger on the REAL mainnet queue: walk SortedTroves from its tail to
    /// a fresh trove and prove how much redeemable debt stands before it.
    function test_mainnet_redemptionQueueProof() public {
        _openPlainTrove(2_500e18);
        (uint256 ahead, bool found) = lens.debtAhead(user, 200);
        console2.log("redeemable MUSD ahead of a new 250% trove on mainnet", ahead / 1e18);
        assertTrue(found, "the whole mainnet queue fits in one walk");
    }
}
