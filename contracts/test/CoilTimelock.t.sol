// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CoilBase} from "./CoilRouter.t.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {CoilTimelock} from "../src/CoilTimelock.sol";

/// The router's owner is a 24 h timelock: no owner action can surprise a user.
contract CoilTimelockTest is CoilBase {
    CoilTimelock tl;
    address proposer = makeAddr("proposer");
    uint256 constant DELAY = 24 hours;

    function setUp() public {
        _deploy(true);
        address[] memory p = new address[](1);
        p[0] = proposer;
        tl = new CoilTimelock(DELAY, p);
        router.setOwner(address(tl));
    }

    function _schedule(bytes memory data, bytes32 salt) internal {
        vm.prank(proposer);
        tl.schedule(address(router), 0, data, bytes32(0), salt, DELAY);
    }

    function test_timelock_ownsRouter_oldOwnerLocked() public {
        assertEq(router.owner(), address(tl));
        vm.expectRevert(CoilRouter.Unauthorized.selector);
        router.setFee(10);
    }

    function test_timelock_feeChangeOnlyAfterDelay() public {
        bytes memory data = abi.encodeCall(CoilRouter.setFee, (10));
        _schedule(data, "fee");
        vm.expectRevert(); // TimelockUnexpectedOperationState: not ready
        tl.execute(address(router), 0, data, bytes32(0), "fee");
        vm.warp(block.timestamp + DELAY);
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        tl.execute(address(router), 0, data, bytes32(0), "fee");
        assertEq(router.feeBps(), 10);
    }

    function test_timelock_onlyProposerSchedules() public {
        bytes memory data = abi.encodeCall(CoilRouter.setMaxDeviation, (500));
        vm.prank(alice);
        vm.expectRevert();
        tl.schedule(address(router), 0, data, bytes32(0), "dev", DELAY);
    }

    function test_timelock_cannotShortenDelay() public {
        bytes memory data = abi.encodeCall(CoilRouter.setTreasury, (alice));
        vm.prank(proposer);
        vm.expectRevert(); // TimelockInsufficientDelay
        tl.schedule(address(router), 0, data, bytes32(0), "t", DELAY - 1);
    }

    function test_timelock_proposerCanCancel() public {
        bytes memory data = abi.encodeCall(CoilRouter.setFee, (50));
        _schedule(data, "fee50");
        bytes32 id = tl.hashOperation(address(router), 0, data, bytes32(0), "fee50");
        vm.prank(proposer);
        tl.cancel(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        tl.execute(address(router), 0, data, bytes32(0), "fee50");
        assertEq(router.feeBps(), 0);
    }

    /// The hard caps still bind through the timelock.
    function test_timelock_hardCapsStillApply() public {
        bytes memory data = abi.encodeCall(CoilRouter.setMaxDeviation, (501));
        _schedule(data, "cap");
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(); // BadParam bubbles up
        tl.execute(address(router), 0, data, bytes32(0), "cap");
    }
}
