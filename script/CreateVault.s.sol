// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ChainlinkAdapter, IAggregatorV3} from "../src/ChainlinkAdapter.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";

/// @notice Deploys one ChainlinkAdapter per asset, then creates and seeds a vault through the factory, all from
///         .env lists (one entry per asset).
///         forge script script/CreateVault.s.sol --rpc-url robinhood --account <name> --broadcast
contract CreateVault is Script {
    function run() external returns (IndexVault vault) {
        IndexVaultFactory factory = IndexVaultFactory(vm.envAddress("FACTORY"));
        address[] memory tokens = vm.envAddress("ASSETS", ",");
        address[] memory feeds = vm.envAddress("FEEDS", ",");
        uint256[] memory weights = vm.envUint("WEIGHTS_BPS", ",");
        uint256[] memory seed = vm.envUint("SEED_AMOUNTS", ",");
        uint256 maxStale = vm.envOr("MAX_STALE", uint256(90_000)); // ~25h: fails closed over weekends
        uint256 n = tokens.length;
        require(
            feeds.length == n && weights.length == n && seed.length == n,
            "ASSETS, FEEDS, WEIGHTS_BPS, SEED_AMOUNTS must align"
        );

        IndexVault.Asset[] memory assets_ = new IndexVault.Asset[](n);
        vm.startBroadcast();
        for (uint256 i; i < n; ++i) {
            ChainlinkAdapter valuer = new ChainlinkAdapter(IERC20Metadata(tokens[i]), IAggregatorV3(feeds[i]), maxStale);
            assets_[i] = IndexVault.Asset({token: IERC20(tokens[i]), valuer: valuer, weightBps: weights[i]});
            IERC20(tokens[i]).approve(address(factory), seed[i]);
            console.log("ChainlinkAdapter for", tokens[i], "at", address(valuer));
        }
        vault = factory.create(
            vm.envOr("INDEX_NAME", string("Hood Index")), vm.envOr("INDEX_SYMBOL", string("INDEX")), assets_, seed
        );
        vm.stopBroadcast();
        console.log("IndexVault created at", address(vault));
    }
}
