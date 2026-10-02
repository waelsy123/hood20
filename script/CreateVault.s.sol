// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";

/// @notice Creates and seeds a vault through the factory from .env lists (one entry per asset). Assets must already
///         be registered in the config (script/RegisterAssets.s.sol).
///         forge script script/CreateVault.s.sol --rpc-url robinhood --account <name> --broadcast
contract CreateVault is Script {
    function run() external returns (IndexVault vault) {
        IndexVaultFactory factory = IndexVaultFactory(vm.envAddress("FACTORY"));
        address[] memory tokens = vm.envAddress("ASSETS", ",");
        uint256[] memory weights = vm.envUint("WEIGHTS_BPS", ",");
        uint256[] memory seed = vm.envUint("SEED_AMOUNTS", ",");
        uint256 n = tokens.length;
        require(weights.length == n && seed.length == n, "ASSETS, WEIGHTS_BPS, SEED_AMOUNTS must align");

        IndexVault.AssetInput[] memory assets_ = new IndexVault.AssetInput[](n);
        for (uint256 i; i < n; ++i) {
            assets_[i] = IndexVault.AssetInput({token: IERC20(tokens[i]), weightBps: weights[i]});
        }

        vm.startBroadcast();
        for (uint256 i; i < n; ++i) {
            IERC20(tokens[i]).approve(address(factory), seed[i]);
        }
        vault = factory.create(
            vm.envOr("INDEX_NAME", string("Hood Index")), vm.envOr("INDEX_SYMBOL", string("INDEX")), assets_, seed
        );
        vm.stopBroadcast();
        console.log("IndexVault created at", address(vault));
    }
}
