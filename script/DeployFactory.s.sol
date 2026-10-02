// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";

/// @notice Deploys the shared IndexConfig (owned by OWNER, default: the broadcaster) and the factory bound to it.
///         forge script script/DeployFactory.s.sol --rpc-url robinhood --account <name> --broadcast
contract DeployFactory is Script {
    function run() external returns (IndexConfig config, IndexVaultFactory factory) {
        vm.startBroadcast();
        // Outside the broadcast, msg.sender is Foundry's default script sender (0x1804…1f38), not the keystore: an
        // IndexConfig owned by it can never register assets. Read the real broadcaster instead.
        (, address broadcaster,) = vm.readCallers();
        address owner = vm.envOr("OWNER", broadcaster);
        config = new IndexConfig(owner);
        factory = new IndexVaultFactory(config);
        vm.stopBroadcast();
        console.log("IndexConfig deployed at", address(config));
        console.log("IndexVaultFactory deployed at", address(factory));
    }
}
