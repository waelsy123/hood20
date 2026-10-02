// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IPermit2, Zap} from "../src/Zap.sol";

/// @notice Deploys the Zap bound to CONFIG and Permit2, and allowlists the DEX routers in ROUTERS (comma-separated;
///         the broadcaster must own the config).
///         forge script script/DeployZap.s.sol --rpc-url robinhood --account <name> --broadcast
contract DeployZap is Script {
    function run() external returns (Zap zap) {
        IndexConfig config = IndexConfig(vm.envAddress("CONFIG"));
        IPermit2 permit2 = IPermit2(vm.envOr("PERMIT2", address(0x000000000022D473030F116dDEE9F6B43aC78BA3)));
        address[] memory routers = vm.envOr("ROUTERS", ",", new address[](0));
        vm.startBroadcast();
        zap = new Zap(config, permit2);
        for (uint256 i; i < routers.length; ++i) {
            config.setRouter(routers[i], true);
            console.log("router allowed", routers[i]);
        }
        vm.stopBroadcast();
        console.log("Zap deployed at", address(zap));
    }
}
