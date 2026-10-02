// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAggregatorV3} from "../src/ChainlinkAdapter.sol";
import {IndexConfig} from "../src/IndexConfig.sol";

/// @notice Registers every verified (token, feed) pair from data/robinhood-chain-feeds.json in the IndexConfig at
///         CONFIG, deploying one immutable ChainlinkAdapter per pair (idempotent: already-registered triples are
///         skipped). Exchange-rate feeds and feeds without a verified token are ignored.
///         forge script script/RegisterAssets.s.sol --rpc-url robinhood --account <name> --broadcast
contract RegisterAssets is Script {
    function run() external {
        IndexConfig config = IndexConfig(vm.envAddress("CONFIG"));
        uint256 maxStale = vm.envOr("MAX_STALE", uint256(90_000)); // ~25h: fails closed over weekends
        string memory json = vm.readFile("data/robinhood-chain-feeds.json");
        uint256 n = vm.parseJsonUint(json, ".counts.feeds");

        vm.startBroadcast();
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".feeds[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(base, ".kind")))) == keccak256("exchange-rate")) continue;
            if (!vm.keyExistsJson(json, string.concat(base, ".token.onchain.symbolMatches"))) continue;
            if (!vm.parseJsonBool(json, string.concat(base, ".token.onchain.symbolMatches"))) continue;
            address token = vm.parseJsonAddress(json, string.concat(base, ".token.address"));
            address feed = vm.parseJsonAddress(json, string.concat(base, ".proxy"));
            address current = address(config.valuerOf(token));
            address adapter = address(config.registerAsset(IERC20Metadata(token), IAggregatorV3(feed), maxStale));
            console.log(
                vm.parseJsonString(json, string.concat(base, ".symbol")),
                token,
                adapter,
                current == adapter ? "(unchanged)" : ""
            );
        }
        vm.stopBroadcast();
    }
}
