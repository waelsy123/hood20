// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IValuer} from "../src/IValuer.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";
import {MockArb, MockFeed, MockToken} from "./Mocks.sol";

/// Gas profile of a 10-asset vault; the README quotes these numbers. Run: forge test --match-contract GasTest -vv
contract GasTest is Test {
    uint256 constant N = 10;
    MockToken[] tokens;
    MockFeed[] feeds;
    IValuer[] valuers;
    IndexConfig config;
    IndexVaultFactory factory;
    IndexVault vault;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_700_000_000);
        config = new IndexConfig(address(this));
        factory = new IndexVaultFactory(config);
        for (uint256 i; i < N; ++i) {
            tokens.push(new MockToken("T", i % 2 == 0 ? 18 : 6)); // mixed decimals
            feeds.push(new MockFeed(8, int256(100e8 * (i + 1)))); // $100, $200, ... $1,000
            valuers.push(config.registerAsset(tokens[i], feeds[i], 90_000));
        }
    }

    function _configs() internal view returns (IndexVault.AssetInput[] memory a) {
        a = new IndexVault.AssetInput[](N);
        for (uint256 i; i < N; ++i) {
            a[i] = IndexVault.AssetInput({token: tokens[i], weightBps: 1_000});
        }
    }

    /// About $100,000 of each asset.
    function _seed() internal view returns (uint256[] memory s) {
        s = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            s[i] = 1_000 * 10 ** tokens[i].decimals() / (i + 1);
        }
    }

    function _fund(address who, address spender) internal {
        for (uint256 i; i < N; ++i) {
            tokens[i].mint(who, 1e30);
            vm.prank(who);
            tokens[i].approve(spender, type(uint256).max);
        }
    }

    /// Pulls/pushes that land exactly on target while keeping the full incentive.
    function _plan() internal view returns (uint256[] memory pulls, uint256[] memory pushes) {
        (uint256[] memory vals, uint256 nav) = vault.snapshot();
        uint256 misplaced;
        for (uint256 i; i < N; ++i) {
            uint256 target = nav * 1_000 / 10_000;
            if (vals[i] > target) misplaced += vals[i] - target;
        }
        uint256 navAfter = nav - misplaced * config.incentiveBps() / (10_000 + config.creatorShareBps());
        (pulls, pushes) = (new uint256[](N), new uint256[](N));
        for (uint256 i; i < N; ++i) {
            uint256 target = navAfter * 1_000 / 10_000;
            uint256 unit = 10 ** tokens[i].decimals();
            uint256 unitValue = valuers[i].valueOf(unit);
            if (vals[i] > target) pulls[i] = (vals[i] - target) * unit / unitValue;
            else pushes[i] = ((target - vals[i]) * unit + unitValue - 1) / unitValue;
        }
    }

    function test_GasProfileTenAssets() public {
        _fund(alice, address(factory));
        uint256[] memory seed = _seed();
        vm.startPrank(alice);
        uint256 g = gasleft();
        vault = factory.create("Ten", "TEN", _configs(), seed);
        console2.log("factory.create (deploy + seed, 10 assets):", g - gasleft());
        vm.stopPrank();

        _fund(alice, address(vault));
        vm.startPrank(alice);
        g = gasleft();
        (uint256 shares,) = vault.deposit(seed, 0, alice);
        console2.log("deposit (10 assets):", g - gasleft());
        g = gasleft();
        vault.redeem(shares / 2, alice);
        console2.log("redeem (10 assets, no fee):", g - gasleft());
        vm.stopPrank();

        feeds[0].set(int256(110e8)); // asset 0 +10% -> about 90 bps off target
        MockArb arb = new MockArb(vault);
        _fund(address(arb), address(vault));
        (uint256[] memory pulls, uint256[] memory pushes) = _plan();
        uint256[] memory ids = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            ids[i] = i;
        }
        g = gasleft();
        arb.run(ids, pulls, pushes);
        console2.log("rebalance (10 assets listed, callback moves all 10):", g - gasleft());
        assertEq(vault.deviationBps(), 0);
    }
}
