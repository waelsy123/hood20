// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ChainlinkAdapter} from "../src/ChainlinkAdapter.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IValuer} from "../src/IValuer.sol";
import {MockArb, MockFeed, MockToken} from "./Mocks.sol";

contract IndexVaultTest is Test {
    MockToken weth; // 18 decimals, 8-decimal feed
    MockToken stock; // 6 decimals, 18-decimal feed (exercises the scaling)
    MockToken usdg; // 6 decimals, 8-decimal feed (three-asset tests only)
    MockFeed feedWeth;
    MockFeed feedStock;
    MockFeed feedUsdg;
    IndexConfig config; // owned by this test
    IndexVault vault; // two assets, 50/50
    MockArb arb; // rebalancer for `vault`

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address creator = makeAddr("creator"); // recorded on every vault built by _new

    uint256 constant WETH_PRICE = 2500e8; // $2,500
    uint256 constant STOCK_PRICE = 50e18; // $50
    uint256 constant USDG_PRICE = 1e8; // $1
    uint256 constant SEED_WETH = 200e18; // $500,000
    uint256 constant SEED_STOCK = 10_000e6; // $500,000
    uint256 constant FUNDING_WETH = 1_000_000e18;
    uint256 constant FUNDING_STOCK = 1_000_000_000e6;
    uint256 constant FUNDING_USDG = 1_000_000_000e6;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("WETH", 18);
        stock = new MockToken("STOCK", 6);
        usdg = new MockToken("USDG", 6);
        feedWeth = new MockFeed(8, int256(WETH_PRICE));
        feedStock = new MockFeed(18, int256(STOCK_PRICE));
        feedUsdg = new MockFeed(8, int256(USDG_PRICE));
        config = new IndexConfig(address(this));
        vault = _new("Hood 50/50 Index", "INDEX", _twoAssets(5000, 5000));
        arb = new MockArb(vault);
        _fund(alice, address(vault));
        _fund(bob, address(vault));
        _fund(address(arb), address(vault));
        vm.prank(alice);
        vault.deposit(_arr(SEED_WETH, SEED_STOCK), 0, alice);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _new(string memory name, string memory symbol, IndexVault.AssetInput[] memory assets_)
        internal
        returns (IndexVault)
    {
        return new IndexVault(name, symbol, assets_, config, creator);
    }

    /// Registers `token` in the config (idempotent; 25h staleness) and returns the vault input for it.
    function _asset(MockToken token, MockFeed feed, uint256 weightBps) internal returns (IndexVault.AssetInput memory) {
        config.registerAsset(token, feed, 90_000);
        return IndexVault.AssetInput({token: token, weightBps: weightBps});
    }

    function _twoAssets(uint256 w0, uint256 w1) internal returns (IndexVault.AssetInput[] memory a) {
        a = new IndexVault.AssetInput[](2);
        a[0] = _asset(weth, feedWeth, w0);
        a[1] = _asset(stock, feedStock, w1);
    }

    function _threeAssets(uint256 w0, uint256 w1, uint256 w2) internal returns (IndexVault.AssetInput[] memory a) {
        a = new IndexVault.AssetInput[](3);
        a[0] = _asset(weth, feedWeth, w0);
        a[1] = _asset(stock, feedStock, w1);
        a[2] = _asset(usdg, feedUsdg, w2);
    }

    function _arr(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    /// Asset ids 0 .. n-1.
    function _ids(uint256 n) internal pure returns (uint256[] memory r) {
        r = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = i;
        }
    }

    function _fund(address who, address spender) internal {
        weth.mint(who, FUNDING_WETH);
        stock.mint(who, FUNDING_STOCK);
        usdg.mint(who, FUNDING_USDG);
        vm.startPrank(who);
        weth.approve(spender, type(uint256).max);
        stock.approve(spender, type(uint256).max);
        usdg.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    /// Pushes WETH up 3%: $515,000 vs $500,000, 73 bps off target, $7,500 above it.
    function _drift() internal {
        feedWeth.set(int256(2575e8));
    }

    /// The most a rebalancer may keep right now: holders pay at most incentiveBps of the misplaced value, and the
    /// creator's cut (creatorShareBps of the rebalancer's take) comes out of that budget.
    function _incentiveCap(IndexVault v) internal view returns (uint256) {
        (uint256[] memory vals, uint256 nav) = v.snapshot();
        uint256 misplaced;
        for (uint256 i; i < vals.length; ++i) {
            (,, uint256 weight) = v.assets(i);
            uint256 target = nav * weight / 10_000;
            if (vals[i] > target) misplaced += vals[i] - target;
        }
        return misplaced * config.incentiveBps() / (10_000 + config.creatorShareBps());
    }

    /// Pulls/pushes that put every asset exactly on target at NAV - profit (pulls rounded down, pushes up).
    function _plan(IndexVault v, uint256 profit)
        internal
        view
        returns (uint256[] memory pulls, uint256[] memory pushes)
    {
        (uint256[] memory vals, uint256 nav) = v.snapshot();
        uint256 n = vals.length;
        (pulls, pushes) = (new uint256[](n), new uint256[](n));
        for (uint256 i; i < n; ++i) {
            (IERC20 token, IValuer valuer, uint256 weight) = v.assets(i);
            uint256 target = (nav - profit) * weight / 10_000;
            uint256 unit = 10 ** IERC20Metadata(address(token)).decimals();
            uint256 unitValue = valuer.valueOf(unit);
            if (vals[i] > target) pulls[i] = (vals[i] - target) * unit / unitValue;
            else pushes[i] = ((target - vals[i]) * unit + unitValue - 1) / unitValue;
        }
    }

    // ───────────────────────────── construction ─────────────────────────────

    function test_ConstructorValidatesWeightsDuplicatesAndValuers() public {
        IndexVault.AssetInput[] memory badSum = _twoAssets(5000, 4000); // helpers register assets: build first
        vm.expectRevert(IndexVault.InvalidWeights.selector);
        _new("x", "x", badSum);

        IndexVault.AssetInput[] memory zeroWeight = _twoAssets(10_000, 0);
        vm.expectRevert(IndexVault.InvalidWeights.selector);
        _new("x", "x", zeroWeight);

        IndexVault.AssetInput[] memory dup = _twoAssets(5000, 5000);
        dup[1].token = weth;
        vm.expectRevert(IndexVault.DuplicateAsset.selector);
        _new("x", "x", dup);

        IndexVault.AssetInput[] memory ok = _twoAssets(5000, 5000);
        vm.expectRevert(IndexVault.ZeroCreator.selector);
        new IndexVault("x", "x", ok, config, address(0));

        IndexVault.AssetInput[] memory rogue = _twoAssets(5000, 5000);
        rogue[1].token = new MockToken("ROGUE", 18); // never registered by the config owner
        vm.expectRevert(IndexVault.UnknownAsset.selector);
        _new("x", "x", rogue);

        IndexVault v = _new("x", "x", _threeAssets(5000, 3000, 2000));
        assertEq(v.assetCount(), 3);
        assertEq(v.creator(), creator);
        (IERC20 token, IValuer valuer, uint256 weight) = v.assets(2);
        assertEq(address(token), address(usdg));
        assertEq(weight, 2000);
        assertEq(ChainlinkAdapter(address(valuer)).scale(), 1e14); // 6 token decimals + 8 feed decimals

        // Re-registering an asset only affects vaults created afterwards; this one keeps its valuer.
        MockFeed otherFeed = new MockFeed(8, 1e8);
        config.registerAsset(usdg, otherFeed, 3_600);
        (, IValuer still,) = v.assets(2);
        assertEq(address(still), address(valuer));
        assertTrue(address(config.valuerOf(address(usdg))) != address(valuer));
    }

    // ───────────────────────────── deposit / redeem ─────────────────────────────

    function test_FirstDepositMintsOneIndexPerUsd() public view {
        (, uint256 nav) = vault.snapshot();
        assertEq(vault.totalSupply(), 1_000_000e18);
        assertEq(vault.balanceOf(alice), 1_000_000e18);
        assertEq(nav, 1_000_000e18);
        assertEq(vault.deviationBps(), 0);
    }

    function test_FirstDepositRequiresEveryAsset() public {
        IndexVault v = _new("x", "x", _twoAssets(5000, 5000));
        _fund(bob, address(v));
        vm.prank(bob);
        vm.expectRevert(IndexVault.ZeroAmount.selector);
        v.deposit(_arr(1e18, 0), 0, bob);
    }

    function test_DepositIsProRataAndCappedByTheScarcestAsset() public {
        // Bob offers WETH worth 10% of the vault but five times the matching stock: only the match is pulled.
        vm.prank(bob);
        (uint256 shares, uint256[] memory amounts) = vault.deposit(_arr(20e18, 5_000e6), 100_000e18, bob);
        assertEq(shares, 100_000e18);
        assertEq(amounts[0], 20e18);
        assertEq(amounts[1], 1_000e6);
        assertEq(stock.balanceOf(bob), FUNDING_STOCK - 1_000e6);
        assertEq(vault.deviationBps(), 0);
    }

    function test_DepositRevertsBelowMinSharesOrOnWrongLength() public {
        vm.prank(bob);
        vm.expectRevert(IndexVault.Slippage.selector);
        vault.deposit(_arr(20e18, 1_000e6), 100_000e18 + 1, bob);

        vm.prank(bob);
        vm.expectRevert(IndexVault.LengthMismatch.selector);
        vault.deposit(_arr(20e18, 1_000e6, 1), 0, bob);
    }

    function test_RedeemReturnsProRata() public {
        vm.prank(alice);
        uint256[] memory amounts = vault.redeem(250_000e18, bob);
        assertEq(amounts[0], 50e18);
        assertEq(amounts[1], 2_500e6);
        assertEq(weth.balanceOf(bob), FUNDING_WETH + 50e18);
        assertEq(vault.totalSupply(), 750_000e18);
    }

    function testFuzz_DepositThenRedeemCannotExtractValue(uint256 maxA, uint256 maxB) public {
        maxA = bound(maxA, 1, FUNDING_WETH);
        maxB = bound(maxB, 1, FUNDING_STOCK);
        vm.startPrank(bob);
        (uint256 shares, uint256[] memory inAmounts) = vault.deposit(_arr(maxA, maxB), 0, bob);
        uint256[] memory outAmounts = vault.redeem(shares, bob);
        vm.stopPrank();
        assertLe(outAmounts[0], inAmounts[0]);
        assertLe(outAmounts[1], inAmounts[1]);
        assertGe(weth.balanceOf(address(vault)), SEED_WETH);
        assertGe(stock.balanceOf(address(vault)), SEED_STOCK);
    }

    // ───────────────────────────── rebalance (two assets) ─────────────────────────────

    function test_RebalanceRequiresThreshold() public {
        uint256[] memory none = new uint256[](2);
        vm.expectRevert(IndexVault.BelowThreshold.selector);
        arb.run(_ids(2), none, none);

        feedWeth.set(int256(WETH_PRICE * 1019 / 1000)); // +1.9% -> 47 bps, still below 50
        assertEq(vault.deviationBps(), 47);
        vm.expectRevert(IndexVault.BelowThreshold.selector);
        arb.run(_ids(2), none, none);

        _drift(); // +3% -> 73 bps
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, _incentiveCap(vault));
        arb.run(_ids(2), pulls, pushes);
        assertEq(vault.deviationBps(), 0);

        vm.roll(block.number + 18_000); // past the rebalance interval
        vm.expectRevert(IndexVault.BelowThreshold.selector); // balanced again: nothing to rebalance
        arb.run(_ids(2), none, none);
    }

    function test_RebalanceBriefStyleExchangeKeepsTheIncentive() public {
        // $7,500 of WETH sits above target, so the rebalancer may keep 0.5% = $37.50 once the creator share is
        // off. Brief-style exchange: send in the $7,500 shortfall of stock, take $7,537.50 of WETH, asking for
        // pull-rights over WETH only.
        config.set(50, 50, 0, 18_000, 0, address(0));
        _drift();
        uint256 wethOut = uint256(7537.5e18) * 1e26 / (uint256(2575e8) * 1e18);
        uint256 navAfter = (SEED_WETH - wethOut) * uint256(2575e8) * 1e18 / 1e26 + 507_500e18;
        vm.expectEmit();
        emit IndexVault.Rebalanced(address(arb), navAfter, 0);
        arb.run(_ids(1), _arr(wethOut, 0), _arr(0, 150e6));

        assertEq(weth.balanceOf(address(arb)), FUNDING_WETH + wethOut);
        assertEq(stock.balanceOf(address(vault)), SEED_STOCK + 150e6);
        assertEq(arb.allowanceDuringCallback(), type(uint256).max);
        assertEq(weth.allowance(address(vault), address(arb)), 0); // revoked again
        assertEq(vault.deviationBps(), 0); // each asset $18.75 off target: inside 0.01% of NAV
        assertGe(navAfter, 1_015_000e18 - 37.5e18); // NAV lost at most the incentive
    }

    function test_RebalanceRevertsWhenGreedyOrOffTarget() public {
        _drift();
        uint256 cap = _incentiveCap(vault);
        uint256[] memory none = new uint256[](2);

        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, cap * 2 + 1e18); // on target, greedy
        vm.expectRevert(IndexVault.OffTarget.selector);
        arb.run(_ids(2), pulls, pushes);

        (pulls, pushes) = _plan(vault, cap);
        vm.expectRevert(IndexVault.OffTarget.selector); // pulling without pushing
        arb.run(_ids(2), pulls, none);
        vm.expectRevert(IndexVault.OffTarget.selector); // pushing without pulling
        arb.run(_ids(2), none, pushes);
        vm.expectRevert(IndexVault.OffTarget.selector); // doing nothing
        arb.run(_ids(2), none, none);
    }

    function test_RebalanceOnlyLendsListedAssetsAndNeedsACallback() public {
        _drift();
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, 0);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector); // WETH (0) was not listed
        arb.run(_arr(1, 1), pulls, pushes);

        vm.expectRevert(); // a caller without onRebalance cannot rebalance at all
        vault.rebalance(_ids(2), "");
    }

    function test_RebalanceRevertsOnStaleOrBadPrice() public {
        _drift();
        uint256[] memory none = new uint256[](2);

        feedStock.setUpdatedAt(block.timestamp - 90_001);
        vm.expectRevert(ChainlinkAdapter.StalePrice.selector);
        arb.run(_ids(2), none, none);

        feedStock.set(0);
        vm.expectRevert(ChainlinkAdapter.BadPrice.selector);
        arb.run(_ids(2), none, none);
    }

    function test_RebalanceIntervalBetweenRebalances() public {
        assertEq(config.rebalanceInterval(), 18_000); // default: about 30 minutes of Robinhood Chain blocks
        _drift();
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, _incentiveCap(vault));
        arb.run(_ids(2), pulls, pushes);
        assertEq(vault.lastRebalanceBlock(), block.number);

        feedWeth.set(int256(2575e8 * 103 / 100)); // drifts again right away
        (pulls, pushes) = _plan(vault, _incentiveCap(vault));
        vm.roll(block.number + 17_999);
        vm.expectRevert(IndexVault.TooSoon.selector);
        arb.run(_ids(2), pulls, pushes);

        vm.roll(block.number + 1);
        arb.run(_ids(2), pulls, pushes);
        assertEq(vault.deviationBps(), 0);
    }

    // ───────────────────────────── three assets, 50/30/20 ─────────────────────────────

    function _threeAssetVault() internal returns (IndexVault v, MockArb bot) {
        v = _new("Hood 50/30/20", "IDX3", _threeAssets(5000, 3000, 2000));
        bot = new MockArb(v);
        _fund(alice, address(v));
        _fund(address(bot), address(v));
        vm.prank(alice);
        v.deposit(_arr(200e18, 6_000e6, 200_000e6), 0, alice); // $500k / $300k / $200k
    }

    function test_ThreeAssets_DepositAndRedeemProRata() public {
        (IndexVault v,) = _threeAssetVault();
        assertEq(v.totalSupply(), 1_000_000e18);
        assertEq(v.deviationBps(), 0);

        _fund(bob, address(v));
        vm.prank(bob);
        (uint256 shares, uint256[] memory amounts) = v.deposit(_arr(100e18, 600e6, 100_000e6), 0, bob);
        assertEq(shares, 100_000e18); // stock is the scarcest offer: 600 / 6,000 = 10%
        assertEq(amounts[0], 20e18);
        assertEq(amounts[1], 600e6);
        assertEq(amounts[2], 20_000e6);

        vm.prank(bob);
        uint256[] memory out = v.redeem(shares, bob);
        assertEq(out[0], 20e18);
        assertEq(out[1], 600e6);
        assertEq(out[2], 20_000e6);
    }

    function test_ThreeAssets_RebalanceLandsOnTargetKeepingTheIncentive() public {
        (IndexVault v, MockArb bot) = _threeAssetVault();
        feedWeth.set(int256(WETH_PRICE * 110 / 100)); // WETH $550k: NAV $1.05M, $25k above its $525k target
        assertEq(v.deviationBps(), 238); // 25,000 / 1,050,000
        uint256 cap = _incentiveCap(v);
        assertEq(cap, uint256(25_000e18) * 50 / 11_000); // $113.64 for the rebalancer, $11.36 for the creator

        // Only WETH leaves the vault, so pull-rights are requested over WETH alone; stock and USDG are pushed in.
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(v, cap);
        bot.run(_ids(1), pulls, pushes);

        assertEq(v.deviationBps(), 0);
        (uint256[] memory vals, uint256 nav) = v.snapshot();
        assertApproxEqAbs(nav, 1_050_000e18 - cap, 1e15);
        assertApproxEqAbs(vals[0], nav * 5000 / 10_000, 1e15);
        assertApproxEqAbs(vals[1], nav * 3000 / 10_000, 1e15);
        assertApproxEqAbs(vals[2], nav * 2000 / 10_000, 1e15);
        assertApproxEqAbs(v.balanceOf(creator) * nav / v.totalSupply(), cap / 10, 1e15);
        assertEq(weth.allowance(address(v), address(bot)), 0);
    }

    function testFuzz_RebalanceLandsOnTargetAndKeepsAtMostTheIncentive(
        uint256[3] memory bals,
        uint256[3] memory prices,
        uint256 w0,
        uint256 w1,
        uint256 keep
    ) public {
        w0 = bound(w0, 1000, 8000);
        w1 = bound(w1, 1000, 9000 - w0);
        IndexVault v = _new("f", "f", _threeAssets(w0, w1, 10_000 - w0 - w1));
        weth.mint(address(v), bound(bals[0], 1_000e18, 1e27)); // 1,000 .. 1e9 WETH
        stock.mint(address(v), bound(bals[1], 1_000e6, 1e15)); // 1,000 .. 1e9 stock
        usdg.mint(address(v), bound(bals[2], 1_000e6, 1e15)); // 1,000 .. 1e9 usdg
        feedWeth.set(int256(bound(prices[0], 1e8, 1e12))); // $1 .. $10,000
        feedStock.set(int256(bound(prices[1], 1e18, 5e21))); // $1 .. $5,000
        feedUsdg.set(int256(bound(prices[2], 1e7, 1e9))); // $0.10 .. $10
        MockArb bot = new MockArb(v);
        weth.mint(address(bot), type(uint128).max);
        stock.mint(address(bot), type(uint128).max);
        usdg.mint(address(bot), type(uint128).max);

        if (v.deviationBps() < config.thresholdBps()) {
            vm.expectRevert(IndexVault.BelowThreshold.selector);
            bot.run(_ids(3), new uint256[](3), new uint256[](3));
            return;
        }
        uint256 cap = _incentiveCap(v);
        (, uint256 navBefore) = v.snapshot();

        // Keeping more than the incentive is refused even when every asset lands on target...
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(v, cap * 2 + 1e17);
        vm.expectRevert(IndexVault.OffTarget.selector);
        bot.run(_ids(3), pulls, pushes);

        // ...while keeping any share of it succeeds and leaves the vault balanced with allowances revoked.
        (pulls, pushes) = _plan(v, bound(keep, 0, cap));
        bot.run(_ids(3), pulls, pushes);
        (, uint256 navAfter) = v.snapshot();
        assertEq(v.deviationBps(), 0);
        assertGe(navAfter, navBefore - cap);
        assertEq(v.balanceOf(creator), 0); // no shares exist in this vault, so there is nothing to mint the creator
        for (uint256 i; i < 3; ++i) {
            (IERC20 token,,) = v.assets(i);
            assertEq(token.allowance(address(v), address(bot)), 0);
        }
    }

    // ───────────────────────────── config ─────────────────────────────

    function test_RedeemFeeGoesToRecipientAsShares() public {
        address treasury = makeAddr("treasury");
        config.set(50, 50, 1_000, 18_000, 100, treasury); // 1% redeem fee
        vm.expectEmit();
        emit IndexVault.Redeem(alice, bob, _arr(49.5e18, 2_475e6), 247_500e18, 2_500e18);
        vm.prank(alice);
        uint256[] memory amounts = vault.redeem(250_000e18, bob);
        assertEq(amounts[0], 49.5e18); // 99% of the slice is redeemed...
        assertEq(amounts[1], 2_475e6);
        assertEq(vault.balanceOf(treasury), 2_500e18); // ...and 1% stays with the recipient as INDEX
        assertEq(vault.totalSupply(), 752_500e18);
        assertEq(vault.balanceOf(alice), 750_000e18);
    }

    function test_ConfigChangesApplyToEveryVaultLive() public {
        _drift(); // 73 bps off target
        uint256[] memory none = new uint256[](2);
        config.set(100, 50, 1_000, 18_000, 0, address(0)); // threshold raised to 1%: no longer rebalanceable
        vm.expectRevert(IndexVault.BelowThreshold.selector);
        arb.run(_ids(2), none, none);

        config.set(50, 0, 1_000, 18_000, 0, address(0)); // no incentive: keeping anything reverts, a free rebalance passes
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, 1e18);
        vm.expectRevert(IndexVault.OffTarget.selector);
        arb.run(_ids(2), pulls, pushes);
        (pulls, pushes) = _plan(vault, 0);
        arb.run(_ids(2), pulls, pushes);
        assertEq(vault.deviationBps(), 0);
        assertEq(vault.balanceOf(creator), 0); // nothing was kept, so nothing is shared
    }

    function test_RebalanceSplitsTheIncentiveWithTheCreator() public {
        _drift(); // $7,500 misplaced: holders pay at most $37.50, of which the rebalancer keeps up to $34.09
        uint256 cap = _incentiveCap(vault);
        assertEq(cap, uint256(7_500e18) * 50 / 11_000);
        (uint256[] memory pulls, uint256[] memory pushes) = _plan(vault, cap);
        arb.run(_ids(2), pulls, pushes);

        (, uint256 nav) = vault.snapshot();
        uint256 creatorShares = vault.balanceOf(creator);
        assertGt(creatorShares, 0);
        assertApproxEqAbs(creatorShares * nav / vault.totalSupply(), cap / 10, 1e15); // 10% of the rebalancer's take
        // Holders paid exactly the configured 0.5% of the misplaced value: NAV per share fell by $37.50 / 1M shares.
        uint256 pps = nav * 1e18 / vault.totalSupply();
        assertApproxEqAbs(pps, (1_015_000e18 - 37.5e18) * 1e18 / 1_000_000e18, 1e9);
    }
}
