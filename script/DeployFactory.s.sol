// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";

/// @notice Deploys the shared IndexConfig (owned by OWNER, default: the broadcaster) and the factory bound to it.
///         forge script script/DeployFactory.s.sol --rpc-url robinhood --account <name> --broadcast
contract DeployFactory is Script {
    function run() external returns (IndexConfig config, IndexVaultFactory factory) {
        address owner = vm.envOr("OWNER", msg.sender);
        vm.startBroadcast();
        config = new IndexConfig(owner);
        factory = new IndexVaultFactory(config);
        vm.stopBroadcast();
        console.log("IndexConfig deployed at", address(config));
        console.log("IndexVaultFactory deployed at", address(factory));
    }
}
