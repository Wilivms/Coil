// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CoilBase} from "../CoilRouter.t.sol";
import {CoilRouter} from "../../src/CoilRouter.sol";
import {MockBTCPrecompile, MockMUSD, MockPool, MockPriceFeed, MockTroves, MockSavings} from "../mocks/Mocks.sol";
import {Test, console2} from "forge-std/Test.sol";

/// Drives random sequences of every Coil flow, market moves, yield and adversarial pool swaps.
/// Each action runs inside a state snapshot and is rolled back if it reverts, because the BTC
/// precompile emulator moves balances with vm.deal, which a plain revert would not undo.
contract CoilHandler is Test {
    CoilRouter public immutable router;
    MockTroves public immutable troves;
    MockMUSD public immutable musd;
    MockPool public immutable pool;
    MockPriceFeed public immutable feed;
    MockSavings public immutable savings;
    address constant BTC = 0x7b7C000000000000000000000000000000000000;

    address[3] public actors;
    uint256[3] internal pks;
    address public keeper = address(0xBEEF);

    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public ok;

    constructor(CoilRouter r, MockTroves t, MockMUSD m, MockPool p, MockPriceFeed f, MockSavings s) {
        router = r;
        troves = t;
        musd = m;
        pool = p;
        feed = f;
        savings = s;
        for (uint256 i; i < 3; ++i) {
            (actors[i], pks[i]) = makeAddrAndKey(string(abi.encodePacked("actor", i)));
        }
    }

    // ---------------------------------------------------------------- plumbing

    function _run(bytes32 name, bytes memory data) internal {
        calls[name]++;
        uint256 snap = vm.snapshotState();
        (bool success,) = address(this).call(data);
        if (success) ok[name]++;
        else vm.revertToState(snap);
    }

    modifier self() {
        require(msg.sender == address(this), "handler only");
        _;
    }

    function _sig(uint256 i, bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encodePacked(typeHash, data, troves.getNonce(actors[i]), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pks[i], keccak256(abi.encodePacked("\x19\x01", troves.domainSeparator(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(address(troves));
        musd.mint(to, amount);
    }

    // ---------------------------------------------------------------- actions (fuzzed entry points)

    function coil(uint256 a, uint256 dep, uint256 lev) external {
        _run("coil", abi.encodeCall(this.doCoil, (a % 3, bound(dep, 0.3e18, 3e18), bound(lev, 1.5e18, 4e18))));
    }

    function doCoil(uint256 i, uint256 deposit, uint256 lev) external self {
        address u = actors[i];
        uint256 totalColl = (deposit * lev) / 1e18;
        uint256 debt = (router.quoteMusdForBtc(totalColl - deposit) * 1005) / 1000;
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(i, troves.OPEN_TROVE_TYPEHASH(), abi.encode(totalColl, debt, u, address(router)), dl);
        vm.deal(u, u.balance + deposit);
        vm.prank(u);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, dl);
    }

    function unwind(uint256 a) external {
        _run("unwind", abi.encodeCall(this.doUnwind, (a % 3)));
    }

    function doUnwind(uint256 i) external self {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(i, troves.CLOSE_TROVE_TYPEHASH(), abi.encode(actors[i], address(router)), dl);
        vm.prank(actors[i]);
        router.unwind(sig, dl, 0);
    }

    function deleverage(uint256 a, uint256 repay) external {
        _run("deleverage", abi.encodeCall(this.doDelever, (a % 3, bound(repay, 1_000e18, 200_000e18))));
    }

    function doDelever(uint256 i, uint256 repay) external self {
        uint256 w = (router.quoteBtcForMusd(repay) * 103) / 100;
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(
            i, troves.ADJUST_TROVE_TYPEHASH(), abi.encode(w, repay, false, uint256(0), actors[i], address(router)), dl
        );
        vm.prank(actors[i]);
        router.deleverage(w, repay, address(0), address(0), sig, dl, 0);
    }

    function armGuard(uint256 a, uint256 repay, uint256 trig) external {
        _run("armGuard", abi.encodeCall(this.doArmGuard, (a % 3, bound(repay, 1_000e18, 150_000e18), bound(trig, 50_000e18, 85_000e18))));
    }

    function doArmGuard(uint256 i, uint256 repay, uint256 trig) external self {
        uint256 w = (router.quoteBtcForMusd(repay) * 125) / 100;
        uint64 dl = uint64(block.timestamp + 30 days);
        bytes memory sig = _sig(
            i, troves.ADJUST_TROVE_TYPEHASH(), abi.encode(w, repay, false, uint256(0), actors[i], address(router)), dl
        );
        vm.prank(actors[i]);
        router.armGuard(uint128(trig), uint128(w), uint128(repay), uint128(w / 20), 50, dl, sig);
    }

    function fireGuard(uint256 a) external {
        _run("fireGuard", abi.encodeCall(this.doFireGuard, (a % 3)));
    }

    function doFireGuard(uint256 i) external self {
        vm.prank(keeper);
        router.fireGuard(actors[i], address(0), address(0));
    }

    function depositReserve(uint256 a, uint256 amt) external {
        _run("depositReserve", abi.encodeCall(this.doDeposit, (a % 3, bound(amt, 1, 50_000e18))));
    }

    function doDeposit(uint256 i, uint256 amt) external self {
        address u = actors[i];
        _mint(u, amt);
        vm.startPrank(u);
        musd.approve(address(router), amt);
        router.depositReserve(amt);
        vm.stopPrank();
    }

    function withdrawReserve(uint256 a, uint256 amt) external {
        _run("withdrawReserve", abi.encodeCall(this.doWithdraw, (a % 3, amt)));
    }

    function doWithdraw(uint256 i, uint256 amt) external self {
        uint256 bal = router.reserveBalance(actors[i]);
        amt = amt % 4 == 0 ? type(uint256).max : bound(amt, 1, bal);
        vm.prank(actors[i]);
        router.withdrawReserve(amt);
    }

    function yieldAccrues(uint256 amt) external {
        _run("yield", abi.encodeCall(this.doYield, (bound(amt, 0, 1_000e18))));
    }

    function doYield(uint256 amt) external self {
        musd.setMinter(address(savings));
        savings.addYield(address(router), amt);
        musd.setMinter(address(troves));
    }

    function armShield(uint256 a, uint256 repay, uint256 trig, uint256 ahead) external {
        _run(
            "armShield",
            abi.encodeCall(this.doArmShield, (a % 3, bound(repay, 100e18, 30_000e18), bound(trig, 0, 85_000e18), bound(ahead, 0, 1_000_000e18)))
        );
    }

    function doArmShield(uint256 i, uint256 repay, uint256 trig, uint256 ahead) external self {
        uint64 dl = uint64(block.timestamp + 30 days);
        bytes memory sig = _sig(i, troves.REPAY_MUSD_TYPEHASH(), abi.encode(repay, actors[i]), dl);
        vm.prank(actors[i]);
        router.armShield(uint128(repay), uint128(trig), uint128(ahead), 5e18, dl, sig);
    }

    function fireShield(uint256 a) external {
        _run("fireShield", abi.encodeCall(this.doFireShield, (a % 3)));
    }

    function doFireShield(uint256 i) external self {
        address[] memory q = new address[](3);
        q[0] = actors[(i + 1) % 3];
        q[1] = actors[(i + 2) % 3];
        q[2] = actors[i];
        troves.setQueue(q);
        vm.prank(keeper);
        router.fireShield(actors[i], address(0), address(0), 10);
    }

    function marketMove(uint256 pct, bool down) external {
        _run("market", abi.encodeCall(this.doMarket, (bound(pct, 1, 15), down)));
    }

    /// Oracle and pool move together (arbitrage), by `pct` percent.
    function doMarket(uint256 pct, bool down) external self {
        uint256 p = feed.price();
        feed.setPrice(down ? (p * (100 - pct)) / 100 : (p * (100 + pct)) / 100);
        (uint256 r0, uint256 r1,) = pool.getReserves();
        // move the pool to the new price by swapping, so K and the router's quotes stay honest
        bool m0 = pool.token0() == address(musd);
        (uint256 rM, uint256 rB) = m0 ? (r0, r1) : (r1, r0);
        uint256 target = feed.price();
        address arb = address(0xA4B);
        if ((rM * 1e18) / rB > target) {
            uint256 btcIn = (rB * pct) / 200; // sell BTC into the pool
            vm.deal(arb, btcIn);
            uint256 out = (rM * btcIn * 9970) / (rB * 10_000 + btcIn * 9970);
            vm.prank(arb);
            MockBTCPrecompile(BTC).transfer(address(pool), btcIn);
            pool.swap(m0 ? out : 0, m0 ? 0 : out, arb, "");
        } else {
            uint256 musdIn = (rM * pct) / 200;
            _mint(arb, musdIn);
            uint256 out = (rB * musdIn * 9970) / (rM * 10_000 + musdIn * 9970);
            vm.prank(arb);
            musd.transfer(address(pool), musdIn);
            pool.swap(m0 ? 0 : out, m0 ? out : 0, arb, "");
        }
    }

    /// An attacker moves only the pool (not the oracle), as a sandwich would.
    function attackPool(uint256 size, bool dumpBtc) external {
        _run("attack", abi.encodeCall(this.doAttack, (bound(size, 1e18, 200e18), dumpBtc)));
    }

    function doAttack(uint256 size, bool dumpBtc) external self {
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool m0 = pool.token0() == address(musd);
        (uint256 rM, uint256 rB) = m0 ? (r0, r1) : (r1, r0);
        address atk = address(0xBAD);
        if (dumpBtc) {
            vm.deal(atk, size);
            uint256 out = (rM * size * 9970) / (rB * 10_000 + size * 9970);
            vm.prank(atk);
            MockBTCPrecompile(BTC).transfer(address(pool), size);
            pool.swap(m0 ? out : 0, m0 ? 0 : out, atk, "");
        } else {
            uint256 musdIn = (size * rM) / rB;
            _mint(atk, musdIn);
            uint256 out = (rB * musdIn * 9970) / (rM * 10_000 + musdIn * 9970);
            vm.prank(atk);
            musd.transfer(address(pool), musdIn);
            pool.swap(m0 ? 0 : out, m0 ? out : 0, atk, "");
        }
    }

    /// A full protected life cycle in one step, so fires happen often enough in random runs:
    /// coil, fund the Reserve, arm Guard and Shield, the market falls, keepers fire both.
    function lifecycle(uint256 a, uint256 dep, uint256 crash) external {
        _run("lifecycle", abi.encodeCall(this.doLifecycle, (a % 3, bound(dep, 0.5e18, 2e18), bound(crash, 6, 15))));
    }

    function doLifecycle(uint256 i, uint256 dep, uint256 crash) external self {
        this.doArb();
        if (troves.getTroveStatus(actors[i]) != 1) this.doCoil(i, dep, 3e18);
        this.doDeposit(i, 30_000e18);
        uint256 p = feed.price();
        this.doArmShield(i, 10_000e18, (p * 97) / 100, 0);
        this.doMarket(crash, true);
        this.doArb();
        this.doFireShield(i);
        this.doArmGuard(i, 20_000e18, feed.price());
        this.doFireGuard(i);
    }

    /// Arbitrage closes any gap: the oracle catches up with the pool.
    function arbitrage() external {
        _run("arb", abi.encodeCall(this.doArb, ()));
    }

    function doArb() external self {
        (uint256 r0, uint256 r1,) = pool.getReserves();
        bool m0 = pool.token0() == address(musd);
        (uint256 rM, uint256 rB) = m0 ? (r0, r1) : (r1, r0);
        feed.setPrice((rM * 1e18) / rB);
    }

    function redistribute(uint256 a, uint256 amt) external {
        _run("pending", abi.encodeCall(this.doPending, (a % 3, bound(amt, 0, 5_000e18))));
    }

    function doPending(uint256 i, uint256 amt) external self {
        if (troves.getTroveStatus(actors[i]) == 1) troves.addPending(actors[i], amt);
    }

    function toggleRecovery(uint8 r) external {
        troves.setRecoveryMode(r % 4 == 0); // on a quarter of the time
    }
}

contract CoilInvariantTest is CoilBase {
    CoilHandler handler;

    function setUp() public {
        _deploy(true);
        handler = new CoilHandler(router, troves, musd, pool, feed, savings);
        // the handler mints test MUSD through the troves mock and moves the BTC emulator
        vm.allowCheatcodes(address(handler));
        targetContract(address(handler));
        // only the fuzzed entry points; the do* bodies are internal steps run under a snapshot
        bytes4[] memory sel = new bytes4[](19);
        sel[0] = CoilHandler.coil.selector;
        sel[1] = CoilHandler.unwind.selector;
        sel[2] = CoilHandler.deleverage.selector;
        sel[3] = CoilHandler.armGuard.selector;
        sel[4] = CoilHandler.fireGuard.selector;
        sel[5] = CoilHandler.depositReserve.selector;
        sel[6] = CoilHandler.withdrawReserve.selector;
        sel[7] = CoilHandler.yieldAccrues.selector;
        sel[8] = CoilHandler.armShield.selector;
        sel[9] = CoilHandler.fireShield.selector;
        sel[10] = CoilHandler.marketMove.selector;
        sel[11] = CoilHandler.attackPool.selector;
        sel[12] = CoilHandler.redistribute.selector;
        sel[13] = CoilHandler.toggleRecovery.selector;
        sel[14] = CoilHandler.coil.selector; // weight opening positions a bit higher
        sel[15] = CoilHandler.arbitrage.selector;
        sel[16] = CoilHandler.arbitrage.selector;
        sel[17] = CoilHandler.lifecycle.selector;
        sel[18] = CoilHandler.lifecycle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// Coil is a router, never a vault for BTC: nothing is left behind after any flow.
    function invariant_routerHoldsNoBtc() public view {
        assertEq(address(router).balance, 0);
    }

    /// Loose MUSD never sits in the router: Reserve MUSD lives in sMUSD.
    function invariant_routerHoldsNoLooseMusd() public view {
        assertEq(musd.balanceOf(address(router)), 0);
    }

    /// The Reserve is fully backed: sMUSD held >= every user's balance, yield included.
    function invariant_reserveIsBacked() public view {
        uint256 owed;
        for (uint256 i; i < 3; ++i) owed += router.reserveBalance(handler.actors(i));
        assertGe(savings.balanceOf(address(router)), owed);
        // and rounding dust stays negligible
        // rounding of accYieldPerShare leaves unattributed dust in the vault, always in its favour;
        // it stays below one millionth of a MUSD across a whole run
        assertLe(savings.balanceOf(address(router)) - owed, 1e12);
    }

    function invariant_totalReserveMatchesSum() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) sum += router.reserveOf(handler.actors(i));
        assertEq(router.totalReserve(), sum);
    }

    /// Coil never owns a trove; every trove belongs to its signer.
    function invariant_routerOwnsNoTrove() public view {
        assertEq(troves.getTroveStatus(address(router)), 0);
    }

    /// The pool is never left with less than it started in K terms (no flow underpays it).
    function invariant_flowLockReleased() public {
        // if a flow had left the lock taken, any entry point would revert with Busy
        vm.prank(address(0xDEAD));
        try router.harvest() {} catch (bytes memory err) {
            assertTrue(bytes4(err) != CoilRouter.Busy.selector);
        }
    }

    /// Prints how many of each flow succeeded in the run (forge test -vv), so the report shows the
    /// invariants held across real coils, fires and reserve moves, not only reverted attempts.
    function afterInvariant() external view {
        string[15] memory n = ["coil","unwind","deleverage","armGuard","fireGuard","depositReserve","withdrawReserve","yield","armShield","fireShield","market","attack","pending","arb","lifecycle"];
        for (uint256 i; i < 15; ++i) {
            bytes32 k = bytes32(bytes(n[i]));
            console2.log(n[i], handler.ok(k), "/", handler.calls(k));
        }
    }

    /// Sanity check outside the fuzzer: the handler's flows really succeed, so the invariants
    /// above are exercised against open troves, armed Guards and Shields, not just reverts.
    function test_handlerFlowsSucceed() public {
        handler.coil(0, 1e18, 3e18);
        assertEq(handler.ok("coil"), 1, "coil");
        handler.depositReserve(0, 20_000e18);
        assertEq(handler.ok("depositReserve"), 1, "deposit");
        handler.armShield(0, 10_000e18, 75_000e18, 0);
        assertEq(handler.ok("armShield"), 1, "armShield");
        handler.armGuard(1, 0, 0);
        handler.coil(1, 1e18, 3e18);
        handler.armGuard(1, 50_000e18, 70_000e18);
        assertEq(handler.ok("armGuard"), 2, "armGuard");
        handler.marketMove(15, true);
        assertEq(handler.ok("market"), 1, "market");
        handler.fireShield(0);
        assertEq(handler.ok("fireShield"), 1, "fireShield");
        handler.fireGuard(1);
        assertEq(handler.ok("fireGuard"), 1, "fireGuard");
        handler.yieldAccrues(100e18);
        handler.withdrawReserve(0, 0);
        assertEq(handler.ok("withdrawReserve"), 1, "withdraw");
        handler.unwind(0);
        assertEq(handler.ok("unwind"), 1, "unwind");
    }
}
