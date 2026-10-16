// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {
    MockBTCPrecompile, MockMUSD, MockFactory, MockPool, MockPriceFeed, MockTroves
} from "./mocks/Mocks.sol";

contract CoilRouterTest is Test {
    address constant BTC = 0x7b7C000000000000000000000000000000000000;
    uint256 constant PRICE = 80_000e18;

    MockMUSD musd;
    MockPriceFeed feed;
    MockTroves troves;
    MockFactory factory;
    MockPool pool;
    CoilRouter router;

    address alice;
    uint256 alicePk;
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    function setUp() public {
        _deploy(true);
    }

    function _deploy(bool musdFirst) internal {
        vm.etch(BTC, address(new MockBTCPrecompile()).code);
        // On a fork, 0x7b7c…0000 is a live account: the emulator needs explicit cheatcode access.
        vm.allowCheatcodes(BTC);
        musd = new MockMUSD();
        feed = new MockPriceFeed(PRICE);
        troves = new MockTroves(musd, feed);
        factory = new MockFactory();
        pool = musdFirst ? new MockPool(address(musd), BTC, address(factory)) : new MockPool(BTC, address(musd), address(factory));

        // 100 BTC / 8M MUSD -> 80k, same price as the feed
        musd.mint(address(pool), 8_000_000e18);
        vm.deal(address(pool), 100e18);
        pool.sync();
        musd.setMinter(address(troves));

        router = new CoilRouter(
            address(troves), address(troves), address(feed), address(pool), address(musd), BTC, treasury
        );
        (alice, alicePk) = makeAddrAndKey("alice");
        vm.deal(alice, 10e18);
    }

    // ------------------------------------------------------------ signing (mirrors BorrowerOperationsSignatures)

    function _sign(bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, troves.getNonce(alice), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", troves.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        return abi.encodePacked(r, s, v);
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

    function test_unwind_respectsMinOut() public {
        _coil(1e18, 3e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClose(deadline);
        vm.prank(alice);
        vm.expectRevert();
        router.unwind(sig, deadline, 1e18);
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
        withdraw = (router.quoteBtcForMusd(repay) * 110) / 100; // margin for a lower price at trigger time
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes memory sig = _signAdjust(withdraw, repay, deadline);
        vm.prank(alice);
        router.armGuard(trigger, uint128(withdraw), uint128(repay), bounty, deadline, sig);
    }

    function test_guard_firesOnlyBelowTrigger() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CoilRouter.NotTriggered.selector, PRICE, 70_000e18));
        router.fireGuard(alice, address(0), address(0));

        feed.setPrice(69_000e18);
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

    function test_guard_staleAfterOtherTroveOp() public {
        _coil(1e18, 4e18);
        _armGuard(70_000e18, 50);
        (bool armed, bool fresh, bool triggered) = router.guardStatus(alice);
        assertTrue(armed && fresh && !triggered);
        // alice deleverages by hand first: MUSD nonce moves, the stored signature is now stale
        uint256 repay = 10_000e18;
        uint256 w = (router.quoteBtcForMusd(repay) * 102) / 100;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(w, repay, deadline);
        vm.prank(alice);
        router.deleverage(w, repay, address(0), address(0), sig, deadline, 0);

        feed.setPrice(60_000e18);
        (armed, fresh, triggered) = router.guardStatus(alice);
        assertTrue(armed && !fresh && triggered, "status reports the stale signature");
        vm.prank(keeper);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
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

    function test_guard_rejectsHighBounty() public {
        vm.prank(alice);
        vm.expectRevert(CoilRouter.BadParam.selector);
        router.armGuard(70_000e18, 1, 1, 201, uint64(block.timestamp + 1), hex"01");
    }

    // ------------------------------------------------------------ safety

    function test_signatureUsedDirectlyCannotStrandBtc() public {
        _coil(1e18, 4e18);
        // someone replays a Guard-style signature straight against MUSD with the router as recipient
        uint256 repay = 10_000e18;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signAdjust(0.1e18, repay, deadline);
        address griefer = makeAddr("griefer");
        vm.prank(address(troves));
        musd.mint(griefer, repay);
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

    // ------------------------------------------------------------ fuzz: open then close

    function testFuzz_roundTrip(uint256 deposit, uint256 leverageWad) public {
        deposit = bound(deposit, 0.2e18, 5e18);
        leverageWad = bound(leverageWad, 1.25e18, 7e18);
        vm.deal(alice, deposit);
        // The UI refuses plans under 115% after price impact; the fuzz does the same.
        (uint256 totalColl, uint256 debt) = _plan(deposit, leverageWad);
        uint256 composite = debt + debt / 1000 + 200e18;
        vm.assume((totalColl * PRICE) / composite >= 1.15e18);
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
}
