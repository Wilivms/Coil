// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title  CoilTimelock
/// @notice Owner of CoilRouter. Every owner action (fee, default PriceFeed tolerance, treasury,
///         gauge incentives, owner) is scheduled in public and can only run after `delay`.
///         OpenZeppelin's audited TimelockController, unchanged. No admin role: the timelock
///         administers itself, so even its delay can only change through a delayed proposal.
///         Execution is open to anyone once the delay has passed.
contract CoilTimelock is TimelockController {
    constructor(uint256 delay, address[] memory proposers)
        TimelockController(delay, proposers, _anyone(), address(0))
    {}

    function _anyone() private pure returns (address[] memory e) {
        e = new address[](1); // address(0) as executor = anyone may execute a ready operation
    }
}
