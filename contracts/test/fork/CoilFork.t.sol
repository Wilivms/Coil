// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CoilRouter} from "../../src/CoilRouter.sol";
import {MezoAddresses} from "../../script/MezoAddresses.sol";
import {MockBTCPrecompile} from "../mocks/Mocks.sol";

/// Fresh Skip-style aggregator so PriceFeed has a price inside a local fork.
contract ForkAggregator {
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function set(int256 a) external {
        answer = a;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

interface ISortedTroves {
    function getSize() external view returns (uint256);
}

/// Runs Coil against the REAL MUSD contracts and MUSD/BTC pool on Mezo testnet.
///
///   cd contracts && forge test --match-path "test/fork/*" --fork-url mezo_testnet -vv
///
/// Mezo implements BTC (0x7b7c…0000) and the Skip oracle (0x7b7c…0015) as chain precompiles.
/// A local fork cannot execute them, so the test swaps in faithful emulators at those addresses:
/// BTC = ERC-20 view over native balances, oracle = fixed BTC/USD at the pool's own price.
/// Everything else (BorrowerOperationsSignatures EIP-712, TroveManager, SortedTroves, Pool) is the
/// real deployed bytecode.
contract CoilForkTest is Test, MezoAddresses {
    CoilRouter router;
    Net net;
    address user;
    uint256 userPk;

    function setUp() public {
        if (block.chainid != 31611) {
            vm.skip(true);
            return;
        }
        net = testnet();
        vm.etch(net.btc, address(new MockBTCPrecompile()).code);
        vm.allowCheatcodes(net.btc); // the emulator moves native balances with vm.deal

        // Oracle at the pool's mid price so ratios are realistic.
        (uint256 r0, uint256 r1,) = IPoolLike(net.pool).getReserves();
        int256 mid = int256((r0 * 1e18) / r1); // MUSD per BTC (MUSD is token0 on testnet)
        vm.etch(SKIP_ORACLE, address(new ForkAggregator(mid)).code);
        ForkAggregator(SKIP_ORACLE).set(mid);

        router = new CoilRouter(
            net.bos, net.troveManager, net.priceFeed, net.sortedTroves, net.savings, net.pool, net.musd, net.btc, address(this)
        );
        (user, userPk) = makeAddrAndKey("coil-fork-user");
        vm.deal(user, 2e18);
        console2.log("oracle/pool mid price", uint256(mid) / 1e18);
        console2.log("troves before", ISortedTroves(net.sortedTroves).getSize());
    }

    function _sign(bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        uint256 nonce = IBOSNonce(net.bos).getNonce(user);
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, nonce, deadline));
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

    function test_fork_coilThenUnwind() public {
        uint256 deposit = 0.05e18;
        uint256 totalColl = 0.15e18; // 3x
        uint256 debt = (router.quoteMusdForBtc(totalColl - deposit) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(
            keccak256(
                "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
            ),
            abi.encode(totalColl, debt, user, address(router)),
            deadline
        );

        vm.prank(user);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, deadline);

        (uint256 coll, uint256 principal,,,,) = ITMLike(net.troveManager).getEntireDebtAndColl(user);
        assertEq(coll, totalColl, "real trove holds 3x collateral");
        assertEq(ITMLike(net.troveManager).getTroveStatus(user), 1, "trove is the user's");
        assertEq(address(router).balance, 0);
        console2.log("trove debt (MUSD)", principal / 1e18);

        vm.warp(block.timestamp + 7 days); // let interest accrue
        ForkAggregator(SKIP_ORACLE).set(ForkAggregator(SKIP_ORACLE).answer());
        deadline = block.timestamp + 1 hours;
        sig = _sign(
            keccak256("CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)"),
            abi.encode(user, address(router)),
            deadline
        );
        vm.prank(user);
        uint256 out = router.unwind(sig, deadline, 0);
        console2.log("BTC back after a 7 day round trip (sats)", out / 1e10);
        assertEq(ITMLike(net.troveManager).getTroveStatus(user), 2, "closed by owner");
        assertGt(out, (deposit * 95) / 100);
    }

    // ---------------------------------------------------------------- Wave 2

    function _coilFork(uint256 deposit, uint256 totalColl) internal {
        uint256 debt = (router.quoteMusdForBtc(totalColl - deposit) * 1005) / 1000;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(
            keccak256(
                "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
            ),
            abi.encode(totalColl, debt, user, address(router)),
            deadline
        );
        vm.prank(user);
        router.coil{value: deposit}(totalColl, debt, address(0), address(0), sig, deadline);
    }

    /// The live testnet oracle prices BTC ~2% under the pool (MUSD trades under $1 there).
    /// Coil v2 bounds every swap by the oracle and must still open at that real gap.
    function test_fork_coilAtRealOracleGap() public {
        int256 mid = ForkAggregator(SKIP_ORACLE).answer();
        ForkAggregator(SKIP_ORACLE).set((mid * 98) / 100);
        _coilFork(0.05e18, 0.15e18);
        assertEq(ITMLike(net.troveManager).getTroveStatus(user), 1);
    }

    /// Reserve in the REAL sMUSD vault, Shield repays the REAL trove through a REAL RepayMUSD signature.
    function test_fork_reserveAndShieldOnRealMezo() public {
        _coilFork(0.05e18, 0.15e18);
        (, uint256 p0, uint256 i0,,,) = ITMLike(net.troveManager).getEntireDebtAndColl(user);

        deal(net.musd, user, 2_000e18);
        vm.startPrank(user);
        IApprove(net.musd).approve(address(router), 2_000e18);
        router.depositReserve(2_000e18);
        vm.stopPrank();
        assertEq(IApprove(net.savings).balanceOf(address(router)), 2_000e18, "reserve sits in real sMUSD");

        uint256 repay = 1_000e18;
        uint64 deadline = uint64(block.timestamp + 7 days);
        bytes memory sig = _sign(
            keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)"),
            abi.encode(repay, user),
            deadline
        );
        int256 mid = ForkAggregator(SKIP_ORACLE).answer();
        vm.prank(user);
        router.armShield(uint128(repay), uint128(uint256(mid) * 9 / 10), 0, 5e18, deadline, sig);

        ForkAggregator(SKIP_ORACLE).set((mid * 89) / 100);
        address k = makeAddr("keeper");
        vm.prank(k);
        router.fireShield(user, address(0), address(0), 0);

        (, uint256 p1, uint256 i1,,,) = ITMLike(net.troveManager).getEntireDebtAndColl(user);
        assertEq(p0 + i0 - (p1 + i1), repay, "real trove repaid from the reserve");
        assertEq(IApprove(net.musd).balanceOf(k), 5e18, "keeper paid from the reserve");
        assertEq(router.reserveOf(user), 995e18);
        console2.log("shield repaid on the real trove (MUSD)", repay / 1e18);
    }

    /// Walk the REAL redemption queue (300+ troves) up to a fresh Coil trove.
    function test_fork_debtAheadOnRealQueue() public {
        _coilFork(0.05e18, 0.15e18);
        (uint256 ahead, bool found) = router.debtAhead(user, 200);
        console2.log("found in first 200 of the queue", found);
        console2.log("redeemable MUSD ahead of the new trove", ahead / 1e18);
        // A fresh 3x trove (~170% ICR) on testnet sits deep in the queue; at least the walk must
        // not revert and must report a lower bound when it stops early.
        assertTrue(found || ahead > 0);
    }
}

interface IApprove {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPoolLike {
    function getReserves() external view returns (uint256, uint256, uint256);
}

interface ITMLike {
    function getEntireDebtAndColl(address) external view returns (uint256, uint256, uint256, uint256, uint256, uint256);
    function getTroveStatus(address) external view returns (uint256);
}

interface IBOSNonce {
    function getNonce(address) external view returns (uint256);
}
