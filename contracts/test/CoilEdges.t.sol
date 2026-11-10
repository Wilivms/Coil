// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CoilBase} from "./CoilRouter.t.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {MockMUSD, MockSavings} from "./mocks/Mocks.sol";

/// A keeper contract that tries to re-enter the router when it receives its BTC bounty.
contract ReentrantKeeper {
    CoilRouter immutable router;
    address immutable victim;
    bool public reentered;
    bytes public reason;

    constructor(CoilRouter r, address v) {
        router = r;
        victim = v;
    }

    function fire() external {
        router.fireGuard(victim, address(0), address(0));
    }

    receive() external payable {
        // any second entry point while a flow runs must hit the lock
        try router.withdrawReserve(1) {
            reentered = true;
        } catch (bytes memory err) {
            reason = err;
        }
    }
}

contract StablePool {
    bool public constant stable = true;
    address public token0;
    address public token1;
    address public factory;
}

contract OtherPool {
    bool public constant stable = false;
    address public token0 = address(0x1111);
    address public token1 = address(0x2222);
    address public factory;
}

/// Edge cases and adversarial paths found uncovered by `forge coverage`.
contract CoilEdgesTest is CoilBase {
    function setUp() public {
        _deploy(true);
    }

    function _newRouter(address savings_, address pool_) internal returns (CoilRouter) {
        return new CoilRouter(address(troves), address(troves), address(feed), address(troves), savings_, pool_, address(musd), BTC, treasury);
    }

    // ------------------------------------------------------------ construction

    function test_constructor_rejectsStablePool() public {
        StablePool sp = new StablePool();
        vm.expectRevert(CoilRouter.BadPool.selector);
        _newRouter(address(savings), address(sp));
    }

    function test_constructor_rejectsPoolWithoutMusdBtc() public {
        OtherPool op = new OtherPool();
        vm.expectRevert(CoilRouter.BadPool.selector);
        _newRouter(address(savings), address(op));
    }

    function test_constructor_rejectsSavingsForAnotherToken() public {
        MockSavings other = new MockSavings(new MockMUSD());
        vm.expectRevert(CoilRouter.BadParam.selector);
        _newRouter(address(other), address(pool));
    }

    // ------------------------------------------------------------ lock

    /// The keeper's bounty is a native BTC call: a malicious keeper that re-enters during it hits
    /// the lock, so it cannot touch the Reserve or start another flow mid-flight.
    function test_reentrancyFromBountyHitsLock() public {
        _coil(1e18, 4e18);
        uint256 repay = 100_000e18;
        uint256 withdraw = (router.quoteBtcForMusd(repay) * 110) / 100;
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        router.armGuard(70_000e18, uint128(withdraw), uint128(repay), 1, 50, deadline, sig);
        feed.setPrice(69_500e18);

        ReentrantKeeper k = new ReentrantKeeper(router, alice);
        k.fire();
        assertFalse(k.reentered());
        assertEq(bytes4(k.reason()), CoilRouter.Busy.selector);
        assertGt(address(k).balance, 0, "bounty still paid");
    }

    // ------------------------------------------------------------ owner

    function test_owner_transferAndTreasury() public {
        address newOwner = makeAddr("newOwner");
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.setOwner(address(0));
        router.setOwner(newOwner);
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.setTreasury(alice); // old owner lost its rights
        vm.startPrank(newOwner);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.setTreasury(address(0));
        router.setTreasury(alice);
        vm.stopPrank();
        assertEq(router.treasury(), alice);
    }

    // ------------------------------------------------------------ input checks

    function test_coil_nothingToFlash() public {
        vm.prank(alice);
        vm.expectRevert(CoilRouter.NothingToFlash.selector);
        router.coil{value: 1e18}(1e18, 1, address(0), address(0), hex"01", block.timestamp + 1);
    }

    function test_quote_insufficientLiquidity() public {
        vm.expectRevert(CoilRouter.InsufficientLiquidity.selector);
        router.quoteMusdForBtc(1_000e18); // the whole BTC side of the pool
    }

    function test_closeAmount_noDebt() public {
        vm.expectRevert(CoilRouter.NoDebt.selector);
        router.closeAmount(alice);
    }

    function test_deposit_zero() public {
        vm.prank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.depositReserve(0);
    }

    function test_deleverage_respectsMinOut() public {
        _coil(1e18, 4e18);
        uint256 repay = 50_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 102) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.Slippage.selector);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, w);
    }

    function test_deleverage_collateralShort() public {
        _coil(1e18, 4e18);
        uint256 repay = 50_000e18;
        uint256 w = router.quoteBtcForMusd(repay) / 2; // not enough BTC to pay the pool
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.CollateralShort.selector);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0);
    }

    function test_relever_debtTooSmall() public {
        _coil(1e18, 2e18);
        uint256 add = 0.5e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 90) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.DebtTooSmall.selector);
        router.relever(add, debt, address(0), address(0), sig, "", deadline, 0);
    }

    function test_relever_respectsMinOut() public {
        _coil(1e18, 2e18);
        uint256 add = 0.5e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.Slippage.selector);
        router.relever(add, debt, address(0), address(0), sig, "", deadline, debt);
    }

    // ------------------------------------------------------------ expiry and missing orders

    function test_fire_missingOrders() public {
        vm.expectRevert(CoilRouter.NoGuard.selector);
        router.fireRecoil(alice, address(0), address(0));
        vm.expectRevert(CoilRouter.NoShield.selector);
        router.fireShield(alice, address(0), address(0), 0);
    }

    function _armAllThree(uint64 deadline) internal {
        bytes memory g = _signAdjust(1e17, 1_000e18, deadline);
        vm.prank(alice);
        router.armGuard(90_000e18, 1e17, 1_000e18, 1, 0, deadline, g);
        bytes memory sh = _signRepay(1_000e18, deadline);
        vm.prank(alice);
        router.armShield(1_000e18, 90_000e18, 0, 0, deadline, sh);
        bytes memory rc = _signRelever(1e17, 9_000e18, deadline);
        vm.prank(alice);
        router.armRecoil(1.2e18, 1e17, 9_000e18, 0, deadline, rc, "");
    }

    function test_fire_expiredOrders() public {
        _coil(1e18, 3e18);
        _reserve(alice, 10_000e18);
        _armAllThree(uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(CoilRouter.GuardExpired.selector);
        router.fireGuard(alice, address(0), address(0));
        vm.expectRevert(CoilRouter.GuardExpired.selector);
        router.fireShield(alice, address(0), address(0), 0);
        vm.expectRevert(CoilRouter.GuardExpired.selector);
        router.fireRecoil(alice, address(0), address(0));
    }

    function test_disarm_shieldAndRecoil() public {
        _coil(1e18, 3e18);
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes memory sh = _signRepay(1_000e18, deadline);
        bytes memory rc = _signRelever(1e17, 9_000e18, deadline);
        vm.startPrank(alice);
        router.armShield(1_000e18, 90_000e18, 0, 0, deadline, sh);
        router.armRecoil(1.2e18, 1e17, 9_000e18, 0, deadline, rc, "");
        router.disarmShield();
        router.disarmRecoil();
        vm.stopPrank();
        assertEq(router.shieldOf(alice).signature.length, 0);
        assertEq(router.recoilOf(alice).signature.length, 0);
    }

    /// The bounty is carved out of the MUSD the leverage-up returns; a Recoil sized so tight that
    /// the bounty can't be paid refuses to fire instead of short-changing anyone.
    function test_recoil_bountyLargerThanSurplusReverts() public {
        _coil(1e18, 2e18);
        uint256 add = 0.3e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 1001) / 1000; // ~0.1% surplus
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes memory sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        router.armRecoil(1.2e18, uint128(add), uint128(debt), 200, deadline, sig, ""); // 2% bounty
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.Slippage.selector);
        router.fireRecoil(alice, address(0), address(0));
    }

    // ------------------------------------------------------------ incentives and queue

    function test_incentives_cappedByRefund() public {
        router.setIncentives(address(0xB0B), 20); // 0.20% of the debt, more than the 0.5% buffer leaves
        (uint256 totalColl,) = _plan(1e18, 3e18);
        uint256 debt = (router.quoteMusdForBtc(totalColl - 1e18) * 1001) / 1000; // 0.1% buffer only
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
        assertEq(musd.balanceOf(alice), 0, "the whole buffer went to incentives");
        assertEq(router.pendingIncentives(), musd.balanceOf(address(router)));
        assertLt(router.pendingIncentives(), (debt * 20) / 10_000, "capped by what was left");
    }

    function test_queueWalk_cappedAtMaxSteps() public {
        _coil(1e18, 3e18);
        (uint256 ahead, bool found) = lens.debtAhead(alice, 10_000);
        assertFalse(found, "alice is not in the mock queue");
        assertEq(ahead, 0);
    }

    function test_harvest_withoutReserveIsNoop() public {
        router.harvest();
        assertEq(router.accYieldPerShare(), 0);
    }

    // ------------------------------------------------------------ the borrower's own tolerance (v4)

    /// Live on testnet on 10 Nov 2026: the pool sat 5.5% above the PriceFeed after a fast BTC drop,
    /// so every open reverted even at the 5% hard cap. A borrower can now accept that gap for
    /// their own call; the signed amounts still bound what they pay.
    function test_ownTolerance_coilThroughAStandingGap() public {
        feed.setPrice(75_800e18); // pool at 80k: BTC costs ~5.5% more than the oracle says
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, 700);
        assertEq(troves.getTroveStatus(alice), 1);
    }

    function test_ownTolerance_stillBoundsTheSwap() public {
        feed.setPrice(72_000e18); // an 11% gap is past the 7% this borrower accepts
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline, 700);
    }

    function test_ownTolerance_capped() public {
        vm.prank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.unwind(hex"01", block.timestamp + 1, 0, 2001);
    }

    /// Closing must never be trapped: BTC jumped, the pool lags below the oracle, so selling BTC
    /// to the pool looks >3% cheap. The default refuses; the owner of the position can still leave.
    function test_ownTolerance_unwindWhenPoolLagsBelowOracle() public {
        _coil(1e18, 3e18);
        feed.setPrice(86_000e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        uint256 out = router.unwind(sig, deadline, 0, 1000);
        assertGt(out, 0);
        assertEq(troves.getTroveStatus(alice), 2);
    }

    function test_defaultTolerance_unwindRefusedWhenPoolLags() public {
        _coil(1e18, 3e18);
        feed.setPrice(86_000e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.unwind(sig, deadline, 0);
    }

    /// A keeper is never given the borrower's wider tolerance: with the pool 5.5% under the oracle
    /// on the sell side, a Guard does not fire, whatever its owner used for their own calls.
    function test_keeperFlowsKeepTheHardBound() public {
        _coil(1e18, 3e18);
        uint256 repay = 50_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 120) / 100;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.armGuard(90_000e18, uint128(w), uint128(repay), 1, 0, deadline, sig);
        feed.setPrice(85_000e18); // triggered, but the pool pays 80k for BTC worth 85k
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.fireGuard(alice, address(0), address(0));
    }

    function test_ownTolerance_releverAndDeleverage() public {
        _coil(1e18, 2e18);
        feed.setPrice(75_800e18);
        uint256 add = 0.3e18;
        uint256 debt = (router.quoteMusdForBtc(add) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signRelever(add, debt, deadline);
        vm.prank(alice);
        router.relever(add, debt, address(0), address(0), sig, "", deadline, 0, 700);
        feed.setPrice(86_000e18);
        uint256 repay = 20_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 105) / 100;
        sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0, 1000);
        assertEq(address(router).balance, 0);
    }
}
