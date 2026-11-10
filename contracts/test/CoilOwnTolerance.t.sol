// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CoilBase} from "./CoilRouter.t.sol";
import {CoilRouter} from "../src/CoilRouter.sol";

/// v4: a borrower may pick their own PriceFeed tolerance for a swap they send themselves.
/// Keeper-fired flows stay on `maxDeviationBps`. Live trigger: the testnet MUSD/BTC pool sat ~5.5%
/// above the oracle on 10 Nov 2026, past the 5% owner cap, so v3 refused every coil.
contract CoilOwnToleranceTest is CoilBase {
    function setUp() public {
        _deploy(true);
    }

    uint256 constant GAP_PRICE = 75_600e18; // pool at 80k => BTC ~5.8% dearer than the oracle

    function _coilOwn(uint16 dev) internal {
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, dev);
    }

    function test_coil_defaultToleranceRefusesWideGap() public {
        feed.setPrice(GAP_PRICE);
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, 0);
    }

    function test_coil_ownToleranceOpensAtWideGap() public {
        feed.setPrice(GAP_PRICE);
        _coilOwn(800);
        assertEq(troves.getTroveStatus(alice), 1);
        assertEq(address(router).balance, 0);
    }

    function test_coil_ownToleranceTooTightStillReverts() public {
        feed.setPrice(GAP_PRICE);
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, 400);
    }

    function test_ownTolerance_capped() public {
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, 2001);
    }

    /// The choice lasts one call: the next flow is back on the default.
    function test_ownTolerance_doesNotLeakIntoNextCall() public {
        feed.setPrice(GAP_PRICE);
        _coilOwn(800);
        uint256 repay = 50_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 102) / 100;
        // selling BTC into a pool where BTC is dear is favourable: passes on the default too
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0);
        // a leverage-up (buying BTC dear) on the default is refused again
        uint256 add = 0.2e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 1005) / 1000;
        sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.relever(add, debt, address(0), address(0), sig, "", deadline, 0);
    }

    function test_relever_ownTolerance() public {
        feed.setPrice(GAP_PRICE);
        _coilOwn(800);
        uint256 add = 0.2e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        router.relever(add, debt, address(0), address(0), sig, "", deadline, 0, 800);
        assertEq(address(router).balance, 0);
    }

    /// Closing can never be trapped by a gap its owner accepts.
    function test_unwind_ownToleranceWhenPoolIsCheap() public {
        _coil(1e18, 3e18);
        feed.setPrice(84_800e18); // pool at 80k => BTC ~5.7% cheaper than the oracle: selling it loses
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.unwind(sig, deadline, 0, 0);
    }

    function test_unwind_ownToleranceClosesWhenPoolIsCheap() public {
        _coil(1e18, 3e18);
        feed.setPrice(84_800e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        uint256 out = router.unwind(sig, deadline, 0, 800);
        assertGt(out, 0);
        assertEq(troves.getTroveStatus(alice), 2);
    }

    /// A keeper can't widen anything: Guard keeps the owner's 3% bound whatever a borrower chose before.
    function test_guard_staysOnDefaultTolerance() public {
        _coil(1e18, 3e18);
        uint256 repay = 100_000e18;
        uint256 withdraw = (router.quoteBtcForMusd(repay) * 110) / 100;
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        router.armGuard(90_000e18, uint128(withdraw), uint128(repay), 1, 50, deadline, sig);
        feed.setPrice(84_800e18); // trigger, and the pool sells BTC 5.7% under the oracle
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.fireGuard(alice, address(0), address(0));
    }
}
