// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CoilRouter} from "../src/CoilRouter.sol";
import {MezoAddresses} from "./MezoAddresses.sol";

/// Deploy CoilRouter on Mezo.
///
///   cast wallet import coil-deployer --interactive      # once, stores your key encrypted
///   forge script script/Deploy.s.sol --rpc-url mezo_testnet --account coil-deployer --broadcast
///
/// The treasury defaults to the deployer; protocol fee starts at 0.
contract Deploy is Script, MezoAddresses {
    function run() external returns (CoilRouter router) {
        Net memory net = forChain(block.chainid);
        vm.startBroadcast();
        router = new CoilRouter(net.bos, net.troveManager, net.priceFeed, net.pool, net.musd, net.btc, msg.sender);
        vm.stopBroadcast();
        console2.log("CoilRouter deployed at", address(router));
        console2.log("Paste it into app/src/lib/chain.ts -> COIL_ROUTER");
    }
}
