// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {
    MockBTCPrecompile, MockMUSD, MockFactory, MockPool, MockPriceFeed, MockTroves, MockSavings
} from "./mocks/Mocks.sol";

/// Shared deployment and signing helpers for the unit and invariant suites.
abstract contract CoilBase is Test {
    address constant BTC = 0x7b7C000000000000000000000000000000000000;
    uint256 constant PRICE = 80_000e18;

    MockMUSD musd;
    MockPriceFeed feed;
    MockTroves troves;
    MockFactory factory;
    MockPool pool;
    MockSavings savings;
    CoilRouter router;

    address alice;
    uint256 alicePk;
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function _deploy(bool musdFirst) internal {
        vm.etch(BTC, address(new MockBTCPrecompile()).code);
        // On a fork, 0x7b7c…0000 is a live account: the emulator needs explicit cheatcode access.
        vm.allowCheatcodes(BTC);
        musd = new MockMUSD();
        feed = new MockPriceFeed(PRICE);
        troves = new MockTroves(musd, feed);
        factory = new MockFactory();
        savings = new MockSavings(musd);
        pool = musdFirst
            ? new MockPool(address(musd), BTC, address(factory))
            : new MockPool(BTC, address(musd), address(factory));

        // 1,000 BTC / 80M MUSD -> 80k, same price as the feed (testnet's pool holds ~1,300 BTC)
        musd.mint(address(pool), 80_000_000e18);
        vm.deal(address(pool), 1_000e18);
        pool.sync();

        router = new CoilRouter(
            address(troves),
            address(troves),
            address(feed),
            address(troves),
            address(savings),
            address(pool),
            address(musd),
            BTC,
            treasury
        );
        // MockMUSD has one minter: troves mints/burns; savings mints yield through a test hook below.
        musd.setMinter(address(troves));
        (alice, alicePk) = makeAddrAndKey("alice");
        vm.deal(alice, 10e18);
    }

    /// Mint MUSD for tests (MockMUSD only lets its minter mint).
    function _mintMusd(address to, uint256 amount) internal {
        vm.prank(address(troves));
        musd.mint(to, amount);
    }

    /// Credit sMUSD yield to the router.
    function _yield(uint256 amount) internal {
        musd.setMinter(address(savings));
        savings.addYield(address(router), amount);
        musd.setMinter(address(troves));
    }

    // ------------------------------------------------------------ signing (mirrors BorrowerOperationsSignatures)

    function _signFor(uint256 pk, address who, bytes32 typeHash, bytes memory data, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, troves.getNonce(who), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", troves.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        return _signFor(alicePk, alice, typeHash, data, deadline);
    }

    function _signOpen(uint256 totalColl, uint256 debt, uint256 deadline) internal view returns (bytes memory) {
        return _sign(troves.OPEN_TROVE_TYPEHASH(), abi.encode(totalColl, debt, alice, address(router)), deadline);
    }

    function _signClose(uint256 deadline) internal view returns (bytes memory) {
        return _sign(troves.CLOSE_TROVE_TYPEHASH(), abi.encode(alice, address(router)), deadline);
    }

    function _signAdjust(uint256 w, uint256 r, uint256 deadline) internal view returns (bytes memory) {
        return _sign(
            troves.ADJUST_TROVE_TYPEHASH(), abi.encode(w, r, false, uint256(0), alice, address(router)), deadline
        );
    }

    function _signRepay(uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return _sign(troves.REPAY_MUSD_TYPEHASH(), abi.encode(amount, alice), deadline);
    }

    /// Same maths the front end uses: total collateral = deposit * leverage, debt = pool quote + 0.5%.
    function _plan(uint256 deposit, uint256 leverageWad) internal view returns (uint256 totalColl, uint256 debt) {
        totalColl = (deposit * leverageWad) / 1e18;
        debt = (router.quoteMusdForBtc(totalColl - deposit) * 1005) / 1000;
    }

    function _coil(uint256 deposit, uint256 leverageWad) internal returns (uint256 totalColl, uint256 debt) {
        (totalColl, debt) = _plan(deposit, leverageWad);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    function _reserve(address who, uint256 amount) internal {
        _mintMusd(who, amount);
        vm.startPrank(who);
        musd.approve(address(router), amount);
        router.depositReserve(amount);
        vm.stopPrank();
    }

    /// Push the pool price by swapping `btcIn` BTC in (BTC gets cheaper in the pool).
    function _dumpBtc(uint256 btcIn) internal {
        address whale = makeAddr("whale");
        vm.deal(whale, btcIn);
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool m0 = router.musdIsToken0();
        (uint256 rM, uint256 rB) = m0 ? (r0, r1) : (r1, r0);
        uint256 musdOut = (rM * btcIn * 9970) / (rB * 10_000 + btcIn * 9970);
        vm.prank(whale);
        MockBTCPrecompile(BTC).transfer(address(pool), btcIn);
        pool.swap(m0 ? musdOut : 0, m0 ? 0 : musdOut, whale, "");
    }

    /// Push the pool price by swapping `musdIn` MUSD in (BTC gets dearer in the pool).
    function _buyBtc(uint256 musdIn) internal {
        address whale = makeAddr("whale");
        _mintMusd(whale, musdIn);
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool m0 = router.musdIsToken0();
        (uint256 rM, uint256 rB) = m0 ? (r0, r1) : (r1, r0);
        uint256 btcOut = (rB * musdIn * 9970) / (rM * 10_000 + musdIn * 9970);
        vm.prank(whale);
        musd.transfer(address(pool), musdIn);
        pool.swap(m0 ? 0 : btcOut, m0 ? btcOut : 0, whale, "");
    }
}

contract CoilRouterTest is CoilBase {
    function setUp() public {
        _deploy(true);
    }

    // ------------------------------------------------------------ coil

    function test_coil_opensTroveOwnedByUser() public {
        uint256 k0 = pool.reserve0() * pool.reserve1();
        (uint256 totalColl, uint256 debt) = _coil(1e18, 3e18);

        (uint256 coll, uint256 principal,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(coll, totalColl, "trove collateral");
        assertEq(coll, 3e18);
        assertEq(troves.getTroveStatus(alice), 1, "trove belongs to alice");
        assertEq(troves.getTroveStatus(address(router)), 0, "router owns no trove");
        assertEq(principal, debt + debt / 1000 + 200e18, "debt + fee + gas comp");

        // router is left with nothing
        assertEq(address(router).balance, 0);
        assertEq(musd.balanceOf(address(router)), 0);
        // alice spent her deposit and got the 0.5% buffer back in MUSD
        assertEq(alice.balance, 9e18);
        assertGt(musd.balanceOf(alice), 0);
        assertLt(musd.balanceOf(alice), debt / 100);
        // pool invariant holds
        assertGe(pool.reserve0() * pool.reserve1(), k0);
    }

    function test_coil_worksWithBtcAsToken0() public {
        _deploy(false);
        assertFalse(router.musdIsToken0());
        _coil(1e18, 2.5e18);
        (uint256 coll,,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(coll, 2.5e18);
        assertEq(address(router).balance, 0);
    }

    function test_coil_revertsWhenDebtDoesNotCoverPool() public {
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        debt = (debt * 90) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectRevert();
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    function test_coil_revertsOnWrongSigner() public {
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        address bob = makeAddr("bob");
        vm.deal(bob, 2e18);
        vm.prank(bob); // alice's signature, bob's call: trove would be bob's -> invalid
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    function test_coil_revertsAboveMaxLeverage() public {
        (uint256 totalColl, uint256 debt) = _plan(1e18, 12e18); // ICR < 110%
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectRevert();
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    function test_coil_takesProtocolFee() public {
        router.setFee(10); // 0.10%
        uint256 deposit = 1e18;
        uint256 fee = deposit / 1000;
        uint256 totalColl = 3e18;
        uint256 debt = (router.quoteMusdForBtc(totalColl - (deposit - fee)) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, deadline);
        assertEq(treasury.balance, fee);
    }

    // ------------------------------------------------------------ oracle bound (Wave 1 High finding)

    /// An attacker buys BTC right before the coil. The signed debt still covers the dearer pool,
    /// so without the oracle bound the user would silently pay the attacker in lost refund.
    function test_coil_sandwichedPoolReverts() public {
        (uint256 totalColl,) = _plan(1e18, 3e18);
        uint256 debt = (router.quoteMusdForBtc(totalColl - 1e18) * 110) / 100; // generous signed debt
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        _buyBtc(2_400_000e18); // ~3% move
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    /// MUSD has traded under $1, so the pool prices BTC above the oracle. Coil must still work at
    /// the ~2% gap seen on testnet, refuse beyond the tolerance, and work again if the owner widens it.
    function test_coil_toleratesMusdDiscountWithinBound() public {
        feed.setPrice(78_400e18); // pool at 80k => MUSD ~2% under $1
        _coil(1e18, 3e18);
        assertEq(troves.getTroveStatus(alice), 1);
    }

    function test_coil_beyondToleranceReverts() public {
        feed.setPrice(76_800e18); // pool at 80k => MUSD ~4% under $1
        (uint256 totalColl, uint256 debt) = _plan(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signOpen(totalColl, debt, deadline);
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.coil{value: 1e18}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    /// The owner can widen the tolerance (never past 5%) if MUSD trades further from $1.
    /// (Separate test: the BTC emulator's vm.deal survives a reverted call, which would skew the mock pool.)
    function test_coil_widenedToleranceWorksAgain() public {
        feed.setPrice(76_800e18);
        router.setMaxDeviation(500);
        _coil(1e18, 3e18);
        assertEq(troves.getTroveStatus(alice), 1);
    }

    function test_setMaxDeviation_bounds() public {
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.setMaxDeviation(0);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.setMaxDeviation(501);
        vm.prank(alice);
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.setMaxDeviation(400);
    }

    // ------------------------------------------------------------ unwind

    function test_unwind_closesAndReturnsBtc() public {
        _coil(1e18, 3e18);
        uint256 musdHeld = musd.balanceOf(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);

        vm.prank(alice);
        uint256 out = router.unwind(sig, deadline, 0.95e18);

        assertEq(troves.getTroveStatus(alice), 2, "closed by owner");
        assertEq(address(router).balance, 0);
        assertEq(musd.balanceOf(address(router)), 0);
        // round trip costs two pool fees + borrow fee + price impact, but not much more
        assertGt(out, 0.95e18);
        assertLt(out, 1e18);
        assertEq(alice.balance, 9e18 + out);
        assertGe(musd.balanceOf(alice), musdHeld, "buffer refunded");
    }

    function test_unwind_coversAccruedInterest() public {
        _coil(1e18, 3e18);
        troves.accrueInterest(alice, 750e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        router.unwind(sig, deadline, 0);
        assertEq(troves.getTroveStatus(alice), 2);
    }

    /// Wave 1 reviews flagged double-counted pending redistributions across many projects.
    /// MUSD's getEntireDebtAndColl already folds them into principal; Coil must flash exactly that.
    function test_closeAmount_doesNotDoubleCountPending() public {
        _coil(1e18, 3e18);
        (, uint256 p0, uint256 i0,,,) = troves.getEntireDebtAndColl(alice);
        troves.addPending(alice, 1_000e18);
        assertEq(router.closeAmount(alice), p0 + 1_000e18 + i0 - 200e18 + router.CLOSE_BUFFER());

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        uint256 musdBefore = musd.balanceOf(alice);
        vm.prank(alice);
        router.unwind(sig, deadline, 0);
        assertEq(troves.getTroveStatus(alice), 2);
        // only the rounding buffer comes back, nothing was over-flashed
        assertEq(musd.balanceOf(alice) - musdBefore, router.CLOSE_BUFFER());
    }

    function test_unwind_respectsMinOut() public {
        _coil(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        vm.expectRevert();
        router.unwind(sig, deadline, 1e18);
    }

    function test_unwind_sandwichedPoolReverts() public {
        _coil(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        _dumpBtc(35e18); // BTC ~7% cheaper in the pool: closing would sell collateral at a discount
        vm.prank(alice);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.unwind(sig, deadline, 0); // even with no user minimum
    }

    // ------------------------------------------------------------ deleverage

    function test_deleverage_lowersDebtAndRaisesRatio() public {
        _coil(1e18, 4e18);
        (uint256 c0, uint256 d0,,,,) = troves.getEntireDebtAndColl(alice);
        uint256 icr0 = (c0 * PRICE) / d0;

        uint256 repay = 80_000e18;
        uint256 withdraw = (router.quoteBtcForMusd(repay) * 102) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        uint256 out = router.deleverage(withdraw, repay, address(0), address(0), sig, deadline, 0);

        (uint256 c1, uint256 d1,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(d1, d0 - repay);
        assertEq(c1, c0 - withdraw);
        assertGt((c1 * PRICE) / d1, icr0, "safer after");
        assertGt(out, 0);
        assertEq(address(router).balance, 0);
    }

    // ------------------------------------------------------------ guard

    function _armGuard(uint128 trigger, uint16 bounty) internal returns (uint256 withdraw, uint256 repay) {
        repay = 100_000e18;
        withdraw = (router.quoteBtcForMusd(repay) * 125) / 100; // margin for a lower price at trigger time
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        router.armGuard(trigger, uint128(withdraw), uint128(repay), uint128(withdraw / 20), bounty, deadline, sig);
    }

    function test_guard_firesOnlyBelowTrigger() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CoilRouter.NotTriggered.selector, PRICE, 70_000e18));
        router.fireGuard(alice, address(0), address(0));

        // the market falls: oracle and pool move together
        feed.setPrice(76_000e18);
        _dumpBtc(26e18);
        feed.setPrice(69_500e18);
        _dumpBtc(30e18);
        (uint256 c0, uint256 d0,,,,) = troves.getEntireDebtAndColl(alice);
        uint256 aliceBefore = alice.balance;
        vm.prank(keeper);
        uint256 bounty = router.fireGuard(alice, address(0), address(0));

        (uint256 c1, uint256 d1,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(d1, d0 - 100_000e18);
        assertLt(c1, c0);
        assertGt(bounty, 0);
        assertEq(keeper.balance, bounty);
        assertGt(alice.balance, aliceBefore, "rest of released BTC goes to alice");
        assertEq(router.guardOf(alice).signature.length, 0, "guard consumed");
        assertEq(address(router).balance, 0);
    }

    /// The Wave 1 High: a keeper dumps BTC into the pool, then fires the Guard so the user's
    /// collateral is sold cheap. The PriceFeed bound now refuses the swap.
    function test_guard_keeperSandwichReverts() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        feed.setPrice(69_000e18); // oracle crossed the trigger, the pool still sits at ~80k
        _dumpBtc(150e18); // keeper crashes the pool price far below the oracle
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.PriceDeviation.selector);
        router.fireGuard(alice, address(0), address(0));
        assertGt(router.guardOf(alice).signature.length, 0, "guard still armed after the revert");
    }

    function test_guard_respectsSignedMinBtcOut() public {
        _coil(1e18, 4e18);
        uint256 repay = 100_000e18;
        uint256 withdraw = (router.quoteBtcForMusd(repay) * 110) / 100;
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        // demands nearly all the withdrawn BTC back: impossible once the pool is paid
        router.armGuard(70_000e18, uint128(withdraw), uint128(repay), uint128(withdraw), 50, deadline, sig);
        feed.setPrice(69_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.Slippage.selector);
        router.fireGuard(alice, address(0), address(0));
    }

    function test_guard_staleAfterOtherTroveOp() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        (bool armed, bool fresh, bool triggered,) = router.guardStatus(alice);
        assertTrue(armed && fresh && !triggered);
        // alice deleverages by hand first: MUSD nonce moves, the stored signature is now stale
        uint256 repay = 10_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 102) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0);

        feed.setPrice(78_000e18);
        (armed, fresh,,) = router.guardStatus(alice);
        assertTrue(armed && !fresh, "status reports the stale signature");
        feed.setPrice(69_000e18);
        vm.prank(keeper);
        vm.expectRevert();
        router.fireGuard(alice, address(0), address(0));
    }

    function test_guard_disarm() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        vm.prank(alice);
        router.disarmGuard();
        feed.setPrice(60_000e18);
        vm.expectRevert(CoilRouter.NoGuard.selector);
        router.fireGuard(alice, address(0), address(0));
    }

    function test_guard_rejectsBadParams() public {
        vm.startPrank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armGuard(70_000e18, 1, 1, 1, 201, uint64(block.timestamp + 1), hex"01");
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armGuard(70_000e18, 1, 1, 0, 50, uint64(block.timestamp + 1), hex"01"); // no minBtcOut
        vm.stopPrank();
    }

    /// Guard is not limited to Coil positions: any MUSD borrower can sign one for their trove.
    function test_guard_worksOnTroveNotOpenedWithCoil() public {
        troves.setTrove(alice, 2e18, 100_000e18); // opened directly in the Mezo app
        vm.deal(address(troves), 2e18); // the trove's collateral sits in MUSD's ActivePool
        uint256 repay = 40_000e18;
        uint256 withdraw = (router.quoteBtcForMusd(repay) * 112) / 100;
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        router.armGuard(75_000e18, uint128(withdraw), uint128(repay), 1, 0, deadline, sig);
        feed.setPrice(78_000e18);
        _dumpBtc(13e18);
        feed.setPrice(74_800e18);
        _dumpBtc(14e18);
        vm.prank(keeper);
        router.fireGuard(alice, address(0), address(0));
        (, uint256 debt,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(debt, 60_000e18);
    }

    function test_guard_blockedInRecoveryMode_statusSaysSo() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        troves.setRecoveryMode(true);
        feed.setPrice(69_000e18);
        (,,, bool rm) = router.guardStatus(alice);
        assertTrue(rm);
        vm.prank(keeper);
        vm.expectRevert(bytes("BorrowerOps: Collateral withdrawal not permitted Recovery Mode"));
        router.fireGuard(alice, address(0), address(0));
    }

    // ------------------------------------------------------------ reserve

    function test_reserve_depositGoesToSavings() public {
        _reserve(alice, 1_000e18);
        assertEq(router.reserveOf(alice), 1_000e18);
        assertEq(router.totalReserve(), 1_000e18);
        assertEq(savings.balanceOf(address(router)), 1_000e18);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    function test_reserve_yieldSplitsProRata() public {
        address bob = makeAddr("bob");
        _reserve(alice, 1_000e18);
        _reserve(bob, 3_000e18);
        _yield(40e18);
        router.harvest();
        assertEq(router.reserveBalance(alice), 1_010e18);
        assertEq(router.reserveBalance(bob), 3_030e18);
        // a late depositor gets none of the earlier yield
        address carol = makeAddr("carol");
        _reserve(carol, 4_000e18);
        assertEq(router.reserveBalance(carol), 4_000e18);
        assertEq(savings.balanceOf(address(router)), 8_040e18);
    }

    function test_reserve_withdrawAllIncludesYield() public {
        _reserve(alice, 1_000e18);
        _yield(25e18);
        vm.prank(alice);
        router.withdrawReserve(type(uint256).max);
        assertEq(musd.balanceOf(alice), 1_025e18);
        assertEq(router.reserveOf(alice), 0);
        assertEq(router.totalReserve(), 0);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    function test_reserve_onlyOwnerCanWithdraw() public {
        _reserve(alice, 1_000e18);
        address bob = makeAddr("bob");
        vm.prank(bob);
        vm.expectPartialRevert(CoilRouter.ReserveShort.selector);
        router.withdrawReserve(1);
    }

    function test_reserve_rejectsBtc() public {
        vm.deal(address(this), 1e18);
        (bool ok,) = address(router).call{value: 1e18}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------ shield

    function _armShield(uint128 repay, uint128 trigger, uint128 maxAhead, uint128 bounty) internal {
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signRepay(repay, deadline);
        vm.prank(alice);
        router.armShield(repay, trigger, maxAhead, bounty, deadline, sig);
    }

    function test_shield_priceTriggerRepaysFromReserve() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        _armShield(15_000e18, 70_000e18, 0, 10e18);
        (, uint256 d0,,,,) = troves.getEntireDebtAndColl(alice);

        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.NotTriggered.selector);
        router.fireShield(alice, address(0), address(0), 0);

        feed.setPrice(69_000e18);
        vm.prank(keeper);
        uint256 bounty = router.fireShield(alice, address(0), address(0), 0);
        (, uint256 d1,,,,) = troves.getEntireDebtAndColl(alice);
        assertEq(d1, d0 - 15_000e18);
        assertEq(bounty, 10e18);
        assertEq(musd.balanceOf(keeper), 10e18);
        assertEq(router.reserveOf(alice), 4_990e18);
        assertEq(musd.balanceOf(address(router)), 0);
        assertEq(router.shieldOf(alice).signature.length, 0, "consumed");
    }

    /// Recovery Mode forbids collateral withdrawals, so Guard can't act. Shield only repays.
    function test_shield_worksInRecoveryMode() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        _armShield(15_000e18, 70_000e18, 0, 0);
        troves.setRecoveryMode(true);
        feed.setPrice(69_000e18);
        vm.prank(keeper);
        router.fireShield(alice, address(0), address(0), 0);
        assertEq(router.reserveOf(alice), 5_000e18);
    }

    function _queue(address[] memory ahead) internal {
        address[] memory q = new address[](ahead.length + 1);
        for (uint256 i; i < ahead.length; ++i) q[i] = ahead[i];
        q[ahead.length] = alice;
        troves.setQueue(q);
    }

    /// Redemptions take the lowest-ratio troves first. When little debt stands before alice,
    /// her Shield repays to move her back in the queue, before a redeemer gets to her.
    function test_shield_redemptionQueueTrigger() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        address t1 = makeAddr("t1");
        address t2 = makeAddr("t2");
        troves.setTrove(t1, 1e18, 3_000e18); // 2,800 redeemable
        troves.setTrove(t2, 1e18, 5_200e18); // 5,000 redeemable
        address[] memory ahead = new address[](2);
        ahead[0] = t1;
        ahead[1] = t2;
        _queue(ahead);
        (uint256 a, bool found) = router.debtAhead(alice, 10);
        assertTrue(found);
        assertEq(a, 7_800e18);

        _armShield(10_000e18, 0, 5_000e18, 5e18);
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.NotTriggered.selector);
        router.fireShield(alice, address(0), address(0), 10);

        // t2 gets redeemed away / closes: only 2,800 MUSD stands before alice now
        ahead = new address[](1);
        ahead[0] = t1;
        _queue(ahead);
        (,,, bool byPrice, bool byQueue, uint256 a2) = router.shieldStatus(alice, 10);
        assertFalse(byPrice);
        assertTrue(byQueue);
        assertEq(a2, 2_800e18);
        vm.prank(keeper);
        router.fireShield(alice, address(0), address(0), 10);
        assertEq(router.reserveOf(alice), 9_995e18);
    }

    function test_shield_queueSkipsTrovesUnderMcr() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        address sick = makeAddr("sick");
        troves.setTrove(sick, 0.1e18, 50_000e18); // ICR 16%: liquidatable, never redeemed
        address[] memory ahead = new address[](1);
        ahead[0] = sick;
        _queue(ahead);
        (uint256 a, bool found) = router.debtAhead(alice, 10);
        assertTrue(found);
        assertEq(a, 0, "a trove under MCR does not protect alice");
    }

    function test_shield_queueNotProvenWithinStepsDoesNotFire() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        address[] memory ahead = new address[](3);
        for (uint256 i; i < 3; ++i) {
            ahead[i] = makeAddr(string(abi.encode(i)));
            troves.setTrove(ahead[i], 10e18, 2_000e18); // 1,800 each
        }
        _queue(ahead);
        _armShield(10_000e18, 0, 6_000e18, 0);
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.NotTriggered.selector);
        router.fireShield(alice, address(0), address(0), 2); // walk stops before reaching alice
        vm.prank(keeper);
        router.fireShield(alice, address(0), address(0), 10);
    }

    function test_shield_revertsWhenReserveShort() public {
        _coil(1e18, 4e18);
        _reserve(alice, 1_000e18);
        _armShield(15_000e18, 70_000e18, 0, 0);
        feed.setPrice(69_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(CoilRouter.ReserveShort.selector);
        router.fireShield(alice, address(0), address(0), 0);
    }

    function test_shield_rejectsBadParams() public {
        vm.startPrank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armShield(1, 0, 0, 0, uint64(block.timestamp + 1), hex"01"); // no trigger
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armShield(1, 1, 0, 26e18, uint64(block.timestamp + 1), hex"01"); // bounty too high
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armShield(0, 1, 0, 0, uint64(block.timestamp + 1), hex"01");
        vm.stopPrank();
    }

    function test_shield_staleAfterSignedOp() public {
        _coil(1e18, 4e18);
        _reserve(alice, 20_000e18);
        _armShield(15_000e18, 70_000e18, 0, 0);
        uint256 repay = 10_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 102) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0);
        (bool armed, bool fresh,,,,) = router.shieldStatus(alice, 0);
        assertTrue(armed && !fresh);
        feed.setPrice(69_000e18);
        vm.prank(keeper);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        router.fireShield(alice, address(0), address(0), 0);
        assertEq(router.reserveOf(alice), 20_000e18, "reserve untouched by the failed fire");
    }

    // ------------------------------------------------------------ safety

    function test_signatureUsedDirectlyCannotStrandBtc() public {
        _coil(1e18, 4e18);
        // someone replays a Guard-style signature straight against MUSD with the router as recipient
        uint256 repay = 10_000e18;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(0.1e18, repay, deadline);
        address griefer = makeAddr("griefer");
        _mintMusd(griefer, repay);
        vm.prank(griefer);
        vm.expectRevert(bytes("Sending BTC failed")); // router.receive() rejects BTC outside a flow
        troves.adjustTroveWithSignature(0.1e18, repay, false, address(0), address(0), alice, address(router), sig, deadline);
    }

    function test_hookOnlyFromPoolDuringFlow() public {
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.hook(address(router), 0, 1, abi.encode(uint8(2), bytes("")));
        vm.prank(address(pool));
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.hook(address(router), 0, 1, abi.encode(uint8(2), bytes("")));
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(alice);
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.setFee(1);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.setFee(51);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_roundTrip(uint256 deposit, uint256 leverageWad) public {
        deposit = bound(deposit, 0.2e18, 5e18);
        leverageWad = bound(leverageWad, 1.25e18, 7e18);
        vm.deal(alice, deposit);
        // The UI refuses plans under 115% after price impact; the fuzz does the same.
        (uint256 totalColl, uint256 debt) = _plan(deposit, leverageWad);
        uint256 composite = debt + debt / 1000 + 200e18;
        vm.assume((totalColl * PRICE) / composite >= 1.15e18);
        vm.assume(debt + debt / 1000 >= 1_800e18);
        _coil(deposit, leverageWad);
        assertEq(address(router).balance, 0);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        uint256 out = router.unwind(sig, deadline, 0);

        assertLt(out, deposit, "a round trip always costs fees");
        assertGt(out, (deposit * 90) / 100, "but never more than 10% at these sizes");
        assertEq(address(router).balance, 0);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    /// Any pool move beyond the tolerance is refused, whatever its size or direction.
    function testFuzz_guardNeverSellsBelowOracleBound(uint256 dump) public {
        dump = bound(dump, 0, 200e18);
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        feed.setPrice(69_000e18);
        if (dump > 0) _dumpBtc(dump);
        (uint256 rM, uint256 rB,) = router.poolState();
        vm.prank(keeper);
        try router.fireGuard(alice, address(0), address(0)) {
            // it fired: the pool price it sold at was within the bound of the oracle
            uint256 poolPrice = (rM * 1e18) / rB;
            assertGe(poolPrice * 10_300 / 10_000, 69_000e18 * 9_000 / 10_000);
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            // refused by the oracle bound, the user's minimum, or because the signed withdrawal
            // no longer buys the signed repayment at the lower price
            assertTrue(
                sel == CoilRouter.PriceDeviation.selector || sel == CoilRouter.Slippage.selector
                    || sel == CoilRouter.CollateralShort.selector
            );
        }
    }

    function testFuzz_reserveAccounting(uint96 a, uint96 b, uint96 y, uint96 w) public {
        address bob = makeAddr("bob");
        uint256 da = bound(a, 1, 1e30);
        uint256 db = bound(b, 1, 1e30);
        _reserve(alice, da);
        _reserve(bob, db);
        _yield(bound(y, 0, 1e28));
        router.harvest();
        uint256 wa = bound(w, 1, router.reserveBalance(alice));
        vm.prank(alice);
        router.withdrawReserve(wa);
        assertLe(router.reserveBalance(alice) + router.reserveBalance(bob), savings.balanceOf(address(router)));
        assertEq(musd.balanceOf(address(router)), 0);
    }
}
