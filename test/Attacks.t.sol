// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IRebalancer, IndexVault} from "../src/IndexVault.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";
import {MockArb, MockFeed, MockToken} from "./Mocks.sol";

/// A constituent its issuer can pause or blocklist, like a Robinhood Stock Token
/// (beacon proxy, blocklist + pause, adminBurn that bypasses both).
contract IssuerControlledToken is ERC20 {
    uint8 private immutable _dec;
    bool public paused;
    mapping(address => bool) public blocked;

    constructor(string memory s, uint8 d) ERC20(s, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    /// The issuer can destroy any holder's balance; pause and blocklist do not apply.
    function adminBurn(address from, uint256 a) external {
        _update(from, address(0), a);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(!paused, "paused");
            require(!blocked[from] && !blocked[to], "blocked");
        }
        super._update(from, to, value);
    }
}

/// Takes every asset it is lent and gives nothing back.
contract GreedyArb is IRebalancer {
    IndexVault public immutable vault;

    constructor(IndexVault v) {
        vault = v;
    }

    function attack(uint256[] calldata ids) external {
        vault.rebalance(ids, "");
    }

    function onRebalance(bytes calldata) external override {
        uint256 n = vault.assetCount();
        for (uint256 i; i < n; ++i) {
            (IERC20 t,,) = vault.assets(i);
            t.transferFrom(address(vault), address(this), t.balanceOf(address(vault)));
        }
    }
}

/// Re-enters the vault from inside the rebalance callback, while holding pull-rights.
contract ReenterArb is IRebalancer {
    IndexVault public immutable vault;
    uint8 public mode;

    constructor(IndexVault v) {
        vault = v;
    }

    function attack(uint256[] calldata ids, uint8 m) external {
        mode = m;
        vault.rebalance(ids, "");
    }

    function onRebalance(bytes calldata) external override {
        uint256[] memory zero = new uint256[](vault.assetCount());
        uint256[] memory none = new uint256[](0);
        if (mode == 0) vault.deposit(zero, 0, address(this));
        else if (mode == 1) vault.redeem(1, address(this));
        else vault.rebalance(none, "");
    }
}

/// Adversarial review of the deployed design: a third party tries to take or damage a depositor's position.
/// WETH 18 dec / 8-dec feed at $2,500; STOCK 6 dec / 18-dec feed at $50; 50/50, $1M seeded by alice.
contract AttacksTest is Test {
    MockToken weth;
    MockToken stock;
    MockFeed feedWeth;
    MockFeed feedStock;
    IndexConfig config;
    IndexVaultFactory factory;
    IndexVault vault;

    address alice = makeAddr("alice"); // honest depositor, holds every share
    address eve = makeAddr("eve"); // attacker, holds no shares
    address creator = makeAddr("creator");

    uint256 constant SEED_WETH = 200e18; // $500,000
    uint256 constant SEED_STOCK = 10_000e6; // $500,000

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("WETH", 18);
        stock = new MockToken("STOCK", 6);
        feedWeth = new MockFeed(8, 2_500e8);
        feedStock = new MockFeed(18, 50e18);
        config = new IndexConfig(address(this));
        factory = new IndexVaultFactory(config);
        config.registerAsset(weth, feedWeth, 90_000);
        config.registerAsset(stock, feedStock, 90_000);

        IndexVault.AssetInput[] memory a = new IndexVault.AssetInput[](2);
        a[0] = IndexVault.AssetInput({token: weth, weightBps: 5_000});
        a[1] = IndexVault.AssetInput({token: stock, weightBps: 5_000});
        vault = new IndexVault("Index", "INDEX", a, config, creator);

        weth.mint(alice, SEED_WETH);
        stock.mint(alice, SEED_STOCK);
        vm.startPrank(alice);
        weth.approve(address(vault), type(uint256).max);
        stock.approve(address(vault), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        (seed[0], seed[1]) = (SEED_WETH, SEED_STOCK);
        vault.deposit(seed, 0, alice);
        vm.stopPrank();
    }

    function _ids() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[1] = 1;
    }

    /// Moves WETH to $2,600 so one asset sits 98 bps off target and a rebalance becomes possible.
    function _skew() internal returns (uint256 navBefore, uint256 misplaced, uint256 minNav) {
        feedWeth.set(2_600e8);
        (, navBefore) = vault.snapshot();
        misplaced = SEED_WETH * 2_600 - navBefore / 2; // the overweight leg's excess, in 18-dec USD
        minNav = navBefore - misplaced * config.incentiveBps() / (10_000 + config.creatorShareBps());
    }

    // ───────────────────────── can a rebalancer take the vault? ─────────────────────────

    function test_RebalancerCannotWalkOffWithTheVault() public {
        _skew();
        GreedyArb eveArb = new GreedyArb(vault);
        vm.prank(eve);
        vm.expectRevert(IndexVault.OffTarget.selector);
        eveArb.attack(_ids());
        // nothing moved: the whole callback reverted
        assertEq(weth.balanceOf(address(eveArb)), 0);
        assertEq(stock.balanceOf(address(eveArb)), 0);
        assertEq(weth.balanceOf(address(vault)), SEED_WETH);
        assertEq(stock.balanceOf(address(vault)), SEED_STOCK);
    }

    /// The pull-rights are revoked before the balance check, so they cannot outlive the callback.
    function test_PullRightsDoNotSurviveTheCallback() public {
        _skew();
        MockArb arb = new MockArb(vault);
        uint256[] memory pulls = new uint256[](2);
        uint256[] memory pushes = new uint256[](2);
        (pulls[0], pushes[1]) = _balancedMove(0);
        stock.mint(address(arb), pushes[1]);
        arb.run(_ids(), pulls, pushes);
        assertEq(weth.allowance(address(vault), address(arb)), 0);
        assertEq(stock.allowance(address(vault), address(arb)), 0);
        vm.expectRevert();
        vm.prank(address(arb));
        weth.transferFrom(address(vault), address(arb), 1);
    }

    /// Exactly how much a rebalancer can extract, and that one wei more reverts.
    function test_RebalancerExtractionIsCappedByTheIncentive() public {
        (uint256 navBefore,, uint256 minNav) = _skew();
        uint256 cap = navBefore - minNav; // 0.4545% of the misplaced value

        // taking the cap works
        uint256 snap = vm.snapshotState();
        _rebalanceExtracting(cap);
        (, uint256 navAfter) = vault.snapshot();
        assertGe(navAfter, minNav);
        assertApproxEqRel(navBefore - navAfter, cap, 1e12);
        assertLt(cap * 1e18 / navBefore, 5e13, "under 0.005% of NAV per rebalance");
        vm.revertToState(snap);

        // taking 1% more than the cap does not
        (MockArb arb, uint256[] memory pulls, uint256[] memory pushes) = _prepare(cap * 101 / 100);
        vm.expectRevert(IndexVault.OffTarget.selector);
        arb.run(_ids(), pulls, pushes);
    }

    /// A second rebalance in the same window is refused, so the cap cannot be applied in a loop.
    function test_RebalanceCannotBeRepeatedWithinTheInterval() public {
        (uint256 navBefore,, uint256 minNav) = _skew();
        _rebalanceExtracting(navBefore - minNav);
        feedWeth.set(2_700e8); // drift again straight away
        MockArb arb = new MockArb(vault);
        uint256[] memory z = new uint256[](2);
        vm.expectRevert(IndexVault.TooSoon.selector);
        arb.run(_ids(), z, z);
    }

    function test_ReentryFromTheRebalanceCallbackIsBlocked() public {
        _skew();
        ReenterArb arb = new ReenterArb(vault);
        for (uint8 m = 0; m < 3; ++m) {
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            arb.attack(_ids(), m);
        }
    }

    // ───────────────────────── can anyone reach a depositor's allowances? ─────────────────────────

    /// Alice has an unlimited allowance to the vault and the factory, as the dapp sets. Eve cannot reach it.
    function test_UnlimitedAllowancesAreNotReachableByAThirdParty() public {
        vm.startPrank(alice);
        weth.approve(address(factory), type(uint256).max);
        stock.approve(address(factory), type(uint256).max);
        vm.stopPrank();
        assertEq(weth.allowance(alice, address(vault)), type(uint256).max);
        assertEq(weth.allowance(alice, address(factory)), type(uint256).max);

        // the vault only ever pulls from the caller, so Eve's deposit spends Eve's (zero) balance
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (1e18, 50e6);
        vm.prank(eve);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 1e18)
        );
        vault.deposit(amounts, 0, eve);

        // and so does the factory, whatever assets Eve names
        IndexVault.AssetInput[] memory a = new IndexVault.AssetInput[](2);
        a[0] = IndexVault.AssetInput({token: weth, weightBps: 5_000});
        a[1] = IndexVault.AssetInput({token: stock, weightBps: 5_000});
        vm.prank(eve);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 1e18)
        );
        factory.create("Eve", "EVE", a, amounts);

        assertEq(weth.balanceOf(alice) + weth.balanceOf(address(vault)), SEED_WETH);
    }

    /// Shares are the only claim on the assets: without them nothing comes out.
    function test_RedeemingNeedsShares() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, eve, 0, 1));
        vault.redeem(1, eve);
    }

    /// Sending assets to the vault is a gift: the donor cannot take them back out through a rebalance.
    function test_DonationCannotBeRecovered() public {
        weth.mint(eve, 10e18);
        vm.prank(eve);
        weth.transfer(address(vault), 10e18); // $25,000 donated, vault now far off target
        GreedyArb arb = new GreedyArb(vault);
        vm.expectRevert(IndexVault.OffTarget.selector);
        arb.attack(_ids());
        assertEq(weth.balanceOf(address(vault)), SEED_WETH + 10e18);
    }

    // ───────────────────────── what the issuer of a constituent can do ─────────────────────────

    /// HIGH: one paused or blocklisted constituent freezes every redemption of the whole vault.
    function test_OnePausedConstituentFreezesAllRedemptions() public {
        (IndexVault v, IssuerControlledToken stk) = _vaultWithIssuerToken();
        vm.prank(alice);
        v.redeem(1e18, alice); // works while the token behaves

        stk.setPaused(true);
        vm.prank(alice);
        vm.expectRevert("paused");
        v.redeem(1e18, alice); // the other asset is fine, the redemption is not

        stk.setPaused(false);
        stk.setBlocked(address(v), true); // blocklisting the vault does the same
        vm.prank(alice);
        vm.expectRevert("blocked");
        v.redeem(1e18, alice);
    }

    /// HIGH: the issuer can destroy the vault's holding outright; holders eat the loss pro-rata.
    function test_IssuerCanBurnTheVaultsHolding() public {
        (IndexVault v, IssuerControlledToken stk) = _vaultWithIssuerToken();
        (, uint256 navBefore) = v.snapshot();
        stk.adminBurn(address(v), stk.balanceOf(address(v)) / 2);
        (, uint256 navAfter) = v.snapshot();
        assertApproxEqRel(navAfter, navBefore * 3 / 4, 1e12, "half of one 50% leg is a quarter of NAV");
    }

    // ───────────────────────── what a stale oracle is worth to a rebalancer ─────────────────────────

    /// MEDIUM: inside the 25 h staleness window a rebalancer settles at yesterday's price. The incentive cap
    /// is enforced in oracle terms, so a feed that lags the market leaks far more than the cap suggests.
    function test_StalePriceLetsARebalancerBeatTheIncentiveCap() public {
        // the equity feed stopped publishing 20 h ago at $50; the market has since moved to $40
        feedStock.setUpdatedAt(block.timestamp - 20 hours);
        uint256 truePrice = 40e18;
        feedWeth.set(2_600e8); // the 24/7 crypto feed keeps moving, so the vault drifts

        (uint256 navBefore,, uint256 minNav) = _skew();
        uint256 cap = navBefore - minNav;

        (uint256 pullWeth, uint256 pushStock) = _balancedMove(cap);
        MockArb arb = new MockArb(vault);
        uint256[] memory pulls = new uint256[](2);
        uint256[] memory pushes = new uint256[](2);
        (pulls[0], pushes[1]) = (pullWeth, pushStock);
        stock.mint(address(arb), pushStock);
        arb.run(_ids(), pulls, pushes);

        // what the rebalancer gained at real prices, not oracle prices
        uint256 gotUsd = weth.balanceOf(address(arb)) * 2_600;
        uint256 paidUsd = pushStock * truePrice / 1e6;
        assertGt(gotUsd, paidUsd, "profitable");
        uint256 realProfit = gotUsd - paidUsd;
        assertGt(realProfit, cap * 20, "a 20% stale feed leaks more than 20x the incentive cap");
        emit log_named_decimal_uint("incentive cap, USD", cap, 18);
        emit log_named_decimal_uint("real profit on a 20% stale feed, USD", realProfit, 18);
    }

    /// Past the window the adapter fails closed: no rebalance at all, and redemptions still work.
    function test_PastTheWindowTheVaultRefusesToRebalanceButStillRedeems() public {
        feedStock.setUpdatedAt(block.timestamp - 26 hours);
        GreedyArb arb = new GreedyArb(vault);
        vm.expectRevert();
        arb.attack(_ids());
        vm.prank(alice);
        vault.redeem(1e18, alice); // redemptions never read an oracle
    }

    // ───────────────────────── helpers ─────────────────────────

    /// Pull/push that leaves the vault at target weights with `extractUsd` (18-dec USD) removed from NAV.
    function _balancedMove(uint256 extractUsd) internal view returns (uint256 pullWeth, uint256 pushStock) {
        (, uint256 nav) = vault.snapshot();
        uint256 half = (nav - extractUsd) / 2;
        // round both legs up, so the rounding dust lands in the vault and never in the rebalancer's pocket
        pullWeth = weth.balanceOf(address(vault)) - Math.ceilDiv(half, 2_600); // valueOf(a) == a * 2600
        pushStock = Math.ceilDiv(half, 50e12) - stock.balanceOf(address(vault)); // valueOf(a) == a * 50e12
    }

    function _prepare(uint256 extractUsd)
        internal
        returns (MockArb arb, uint256[] memory pulls, uint256[] memory pushes)
    {
        (uint256 pullWeth, uint256 pushStock) = _balancedMove(extractUsd);
        arb = new MockArb(vault);
        pulls = new uint256[](2);
        pushes = new uint256[](2);
        (pulls[0], pushes[1]) = (pullWeth, pushStock);
        stock.mint(address(arb), pushStock);
    }

    function _rebalanceExtracting(uint256 extractUsd) internal {
        (MockArb arb, uint256[] memory pulls, uint256[] memory pushes) = _prepare(extractUsd);
        arb.run(_ids(), pulls, pushes);
    }

    /// A 50/50 vault whose second asset is controlled by its issuer, seeded by alice.
    function _vaultWithIssuerToken() internal returns (IndexVault v, IssuerControlledToken stk) {
        stk = new IssuerControlledToken("RHSTK", 18);
        config.registerAsset(stk, new MockFeed(8, 100e8), 90_000);
        IndexVault.AssetInput[] memory a = new IndexVault.AssetInput[](2);
        a[0] = IndexVault.AssetInput({token: weth, weightBps: 5_000});
        a[1] = IndexVault.AssetInput({token: stk, weightBps: 5_000});
        v = new IndexVault("Issuer", "ISS", a, config, creator);
        weth.mint(alice, 100e18); // $250,000
        stk.mint(alice, 2_500e18); // $250,000
        vm.startPrank(alice);
        weth.approve(address(v), type(uint256).max);
        stk.approve(address(v), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        (seed[0], seed[1]) = (100e18, 2_500e18);
        v.deposit(seed, 0, alice);
        vm.stopPrank();
    }
}
