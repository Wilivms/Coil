// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {CoilLens} from "../src/CoilLens.sol";
import {MezoAddresses} from "./MezoAddresses.sol";

/// Deploy CoilRouter + CoilLens on Mezo.
///
///   cast wallet import coil-deployer --interactive      # once, stores your key encrypted
///   forge script script/Deploy.s.sol --rpc-url mezo_testnet --account coil-deployer --broadcast
///
/// The treasury defaults to the deployer; protocol fee starts at 0. On testnet, 0.05% of each
/// coil's debt goes to the MUSD/BTC gauge's incentives.
contract Deploy is Script, MezoAddresses {
    function run() external returns (CoilRouter router, CoilLens lens) {
        Net memory net = forChain(block.chainid);
        vm.startBroadcast();
        // tx.origin is the broadcasting account here (msg.sender would be Foundry's default sender).
        router = new CoilRouter(
            net.bos, net.troveManager, net.priceFeed, net.sortedTroves, net.savings, net.pool, net.musd, net.btc, tx.origin
        );
        lens = new CoilLens(router);
        if (net.gaugeIncentives != address(0)) router.setIncentives(net.gaugeIncentives, 5);
        vm.stopBroadcast();
        console2.log("CoilRouter deployed at", address(router));
        console2.log("CoilLens deployed at", address(lens));
    }
}
