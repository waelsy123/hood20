// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {MockFeed, MockToken} from "./Mocks.sol";

/// Fuzzed 10-asset indexes: random weights, decimals, prices, size and drift. Two deposit shapes:
///  - the dapp's purchase flow: pick a share count, compute the exact per-asset amounts the vault will pull (ceil
///    pro-rata, `web/src/lib/math.ts depositAmounts`), bring exactly those and deposit with `minShares` = the target;
///  - arbitrary per-asset amounts in no particular ratio.
/// Properties: shares follow the min-over-assets rule, the vault takes only the pro-rata slice and nothing beyond what
/// was offered, existing holders never lose, an exact purchase leaves no dust, and a deposit too small to buy one raw
/// unit of every asset reverts instead of minting zero.
contract DepositFuzzTest is Test {
    uint256 constant N = 10;
    uint256 constant WAD = 1e18;

    IndexConfig config;
    address alice = makeAddr("alice"); // seeds every vault
    address bob = makeAddr("bob"); // the fuzzed depositor

    struct World {
        MockToken[] tokens;
        IndexVault vault;
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        config = new IndexConfig(address(this));
    }

    /// Weights in [1, 1000] bps each, normalised to exactly 10_000.
    function _weights(uint256[10] memory seed) internal pure returns (uint256[] memory w) {
        w = new uint256[](N);
        uint256 sum;
        for (uint256 i; i < N; ++i) {
            w[i] = bound(seed[i], 1, 1000);
            sum += w[i];
        }
        uint256 total;
        uint256 imax;
        for (uint256 i; i < N; ++i) {
            w[i] = w[i] * 10_000 / sum;
            if (w[i] == 0) w[i] = 1;
            total += w[i];
            if (w[i] > w[imax]) imax = i;
        }
        w[imax] = w[imax] + 10_000 - total; // the largest weight absorbs the rounding (it is >= 1000, total is within 9)
    }

    /// Decade-uniform value in [10^lo, 10^hi]: a plain bound() would spend almost every run near the top of the range.
    function _logUniform(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 mag = bound(seed, lo, hi - 1);
        return bound(seed >> 16, 10 ** mag, 10 ** (mag + 1));
    }

    /// Builds tokens, feeds, registry entries and a seeded vault worth about `navUsd`; asset 0 is skewed by
    /// `skewBps/10_000` so the mix is not exactly on target.
    function _build(
        uint256[10] memory wSeed,
        uint256[10] memory dSeed,
        uint256[10] memory pSeed,
        uint256 navUsd,
        uint256 skewBps
    ) internal returns (World memory w) {
        uint256[] memory weights = _weights(wSeed);
        w.tokens = new MockToken[](N);
        IndexVault.AssetInput[] memory inputs = new IndexVault.AssetInput[](N);
        uint256[] memory seed = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            uint8 dec = [6, 8, 18][dSeed[i] % 3];
            w.tokens[i] = new MockToken(string.concat("T", vm.toString(i)), dec);
            uint256 price = bound(pSeed[i], 5e7, 5_000e8); // $0.50 .. $5,000, 8-decimal feed
            config.registerAsset(w.tokens[i], new MockFeed(8, int256(price)), 90_000);
            inputs[i] = IndexVault.AssetInput({token: w.tokens[i], weightBps: weights[i]});
            uint256 units = navUsd * weights[i] * 1e8 * 10 ** dec / (10_000 * price);
            seed[i] = i == 0 ? units * skewBps / 10_000 : units;
            w.tokens[i].mint(alice, seed[i]);
        }
        w.vault = new IndexVault("Fuzz 10", "F10", inputs, config, alice);
        vm.startPrank(alice);
        for (uint256 i; i < N; ++i) {
            w.tokens[i].approve(address(w.vault), type(uint256).max);
        }
        w.vault.deposit(seed, 0, alice);
        vm.stopPrank();
    }

    function _pps(World memory w) internal view returns (uint256) {
        (, uint256 nav) = w.vault.snapshot();
        return nav * WAD / w.vault.totalSupply();
    }

    /// The dapp's math: the exact amounts the vault pulls for `shares` (mulDiv ceil), as depositAmounts() computes.
    function _needs(World memory w, uint256 shares) internal view returns (uint256[] memory amounts) {
        uint256 supply = w.vault.totalSupply();
        amounts = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            amounts[i] = (shares * w.tokens[i].balanceOf(address(w.vault)) + supply - 1) / supply;
        }
    }

    /// Buy exactly `wanted` shares: bring the computed amounts, insist on `wanted`, end with no dust.
    function _runExactPurchase(World memory w, uint256 wanted) internal {
        uint256 supply = w.vault.totalSupply();
        uint256 ppsBefore = _pps(w);
        uint256[] memory needs = _needs(w, wanted);
        for (uint256 i; i < N; ++i) {
            w.tokens[i].mint(bob, needs[i]);
            vm.prank(bob);
            w.tokens[i].approve(address(w.vault), needs[i]);
        }
        vm.prank(bob);
        (uint256 shares, uint256[] memory amounts) = w.vault.deposit(needs, wanted, bob);
        // ceil rounding can only hand out a hair more than asked, never less, and never more than one share-unit per asset
        assertGe(shares, wanted);
        assertLe(shares - wanted, supply / _minBalance(w) + 1);
        for (uint256 i; i < N; ++i) {
            assertEq(amounts[i], needs[i], "the vault pulls exactly what the dapp computed");
            assertEq(w.tokens[i].balanceOf(bob), 0, "an exact purchase leaves no dust");
        }
        assertEq(w.vault.balanceOf(bob), shares);
        assertGe(_pps(w) + 1e3, ppsBefore, "holders never lose");
    }

    function _minBalance(World memory w) internal view returns (uint256 m) {
        m = type(uint256).max;
        for (uint256 i; i < N; ++i) {
            uint256 b = w.tokens[i].balanceOf(address(w.vault));
            if (b < m) m = b;
        }
    }

    /// forge-config: default.fuzz.runs = 400
    function testFuzz_BuyExactSharesTenAssets(
        uint256[10] memory wSeed,
        uint256[10] memory dSeed,
        uint256[10] memory pSeed,
        uint256 navSeed,
        uint256 skewSeed,
        uint256 sharesSeed
    ) public {
        // vaults of $10k .. $100M; purchases from 0.001 INDEX up to the whole current supply
        World memory w = _build(wSeed, dSeed, pSeed, _logUniform(navSeed, 4, 8), bound(skewSeed, 9_800, 10_200));
        _runExactPurchase(w, bound(sharesSeed, 1e15, w.vault.totalSupply()));
    }

    struct Direct {
        uint256[] maxAmounts;
        uint256[] bal;
        uint256 expected;
        uint256 navBefore;
    }

    function _runDirect(World memory w, uint256[10] memory maxSeed) internal {
        uint256 supply = w.vault.totalSupply();
        Direct memory d;
        d.maxAmounts = new uint256[](N);
        d.bal = new uint256[](N);
        d.expected = type(uint256).max;
        for (uint256 i; i < N; ++i) {
            d.bal[i] = w.tokens[i].balanceOf(address(w.vault));
            d.maxAmounts[i] = bound(maxSeed[i], 0, d.bal[i] * 3); // 0 .. 3x the vault's holding, in no particular ratio
            w.tokens[i].mint(bob, d.maxAmounts[i]);
            vm.prank(bob);
            w.tokens[i].approve(address(w.vault), d.maxAmounts[i]);
            uint256 s = d.maxAmounts[i] * supply / d.bal[i];
            if (s < d.expected) d.expected = s;
        }
        (, d.navBefore) = w.vault.snapshot();

        if (d.expected == 0) {
            // some asset is short of one share's worth: the vault refuses instead of minting nothing
            vm.prank(bob);
            vm.expectRevert(IndexVault.Slippage.selector);
            w.vault.deposit(d.maxAmounts, 0, bob);
            return;
        }
        vm.prank(bob);
        (uint256 shares, uint256[] memory amounts) = w.vault.deposit(d.maxAmounts, 0, bob);
        assertEq(shares, d.expected);
        for (uint256 i; i < N; ++i) {
            assertLe(amounts[i], d.maxAmounts[i]); // never more than offered
            assertEq(amounts[i], (shares * d.bal[i] + supply - 1) / supply); // exactly the pro-rata slice, rounded up
            assertEq(w.tokens[i].balanceOf(bob), d.maxAmounts[i] - amounts[i]); // the rest stayed with bob
        }
        (, uint256 navAfter) = w.vault.snapshot();
        assertGe(navAfter * WAD / w.vault.totalSupply() + 1e3, d.navBefore * WAD / supply); // holders never lose

        // Round trip: redeeming everything returns at most what was put in, per asset.
        vm.prank(bob);
        uint256[] memory out = w.vault.redeem(shares, bob);
        for (uint256 i; i < N; ++i) {
            assertLe(out[i], amounts[i]);
        }
    }

    /// forge-config: default.fuzz.runs = 400
    function testFuzz_DirectDepositTenAssetsAnyAmounts(
        uint256[10] memory wSeed,
        uint256[10] memory dSeed,
        uint256[10] memory pSeed,
        uint256 navSeed,
        uint256[10] memory maxSeed
    ) public {
        _runDirect(_build(wSeed, dSeed, pSeed, _logUniform(navSeed, 4, 8), 10_000), maxSeed);
    }
}
