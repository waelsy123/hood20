// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IPermit2, Zap} from "../src/Zap.sol";
import {MockFeed, MockToken} from "./Mocks.sol";

/// Fixed-rate DEX: pulls `tokenIn` from the caller and mints `tokenOut` at `num/den` per raw unit.
contract MockRouter {
    mapping(address => mapping(address => uint256[2])) public rate;

    function setRate(address tIn, address tOut, uint256 num, uint256 den) external {
        rate[tIn][tOut] = [num, den];
    }

    function swap(address tIn, address tOut, uint256 amountIn) external {
        IERC20(tIn).transferFrom(msg.sender, address(this), amountIn);
        uint256[2] memory r = rate[tIn][tOut];
        MockToken(tOut).mint(msg.sender, amountIn * r[0] / r[1]);
    }
}

/// Permit2 stand-in: moves the funds when the "signature" is the magic bytes "ok".
contract MockPermit2 is IPermit2 {
    function permitTransferFrom(
        PermitTransferFrom calldata p,
        SignatureTransferDetails calldata d,
        address owner,
        bytes calldata sig
    ) external {
        require(keccak256(sig) == keccak256("ok"), "bad signature");
        IERC20(p.permitted.token).transferFrom(owner, d.to, d.requestedAmount);
    }
}

contract ZapTest is Test {
    MockToken weth; // 18 dec, $2,500
    MockToken stock; // 6 dec, $50
    MockToken usdg; // 6 dec, $1
    IndexConfig config;
    IndexVault vault;
    MockRouter router;
    MockPermit2 permit2;
    Zap zap;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("WETH", 18);
        stock = new MockToken("STOCK", 6);
        usdg = new MockToken("USDG", 6);
        config = new IndexConfig(address(this));
        config.registerAsset(weth, new MockFeed(8, 2500e8), 90_000);
        config.registerAsset(stock, new MockFeed(18, 50e18), 90_000);
        IndexVault.AssetInput[] memory a = new IndexVault.AssetInput[](2);
        a[0] = IndexVault.AssetInput({token: weth, weightBps: 5000});
        a[1] = IndexVault.AssetInput({token: stock, weightBps: 5000});
        vault = new IndexVault("Hood 50/50", "INDEX", a, config, alice);

        // alice seeds $1M: 200 WETH + 10,000 stock
        weth.mint(alice, 200e18);
        stock.mint(alice, 10_000e6);
        vm.startPrank(alice);
        weth.approve(address(vault), type(uint256).max);
        stock.approve(address(vault), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        (seed[0], seed[1]) = (200e18, 10_000e6);
        vault.deposit(seed, 0, alice);
        vm.stopPrank();

        router = new MockRouter();
        router.setRate(address(usdg), address(weth), 1e18, 2500e6); // 2,500 USDG -> 1 WETH
        router.setRate(address(usdg), address(stock), 1e6, 50e6); // 50 USDG -> 1 stock
        router.setRate(address(weth), address(usdg), 2500e6, 1e18);
        router.setRate(address(stock), address(usdg), 50e6, 1e6);
        config.setRouter(address(router), true);
        permit2 = new MockPermit2();
        zap = new Zap(config, permit2);

        usdg.mint(bob, 100_000e6);
        vm.startPrank(bob);
        usdg.approve(address(zap), type(uint256).max);
        usdg.approve(address(permit2), type(uint256).max);
        vault.approve(address(zap), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(IERC20 tIn, IERC20 tOut, uint256 amountIn) internal view returns (Zap.Call memory) {
        return Zap.Call({
            target: address(router),
            tokenIn: tIn,
            amountIn: amountIn,
            data: abi.encodeCall(MockRouter.swap, (address(tIn), address(tOut), amountIn))
        });
    }

    function _noPermit() internal pure returns (Zap.Permit memory) {
        return Zap.Permit({nonce: 0, deadline: 0, signature: ""});
    }

    function test_ZapInSwapsDepositsAndRefundsLeftovers() public {
        // 10,000 USDG split 4,000 WETH / 6,000 stock: 1.6 WETH binds (ratio is 1 WETH : 50 stock), 40 stock come back.
        Zap.Call[] memory swaps = new Zap.Call[](2);
        swaps[0] = _swap(usdg, weth, 4_000e6);
        swaps[1] = _swap(usdg, stock, 6_000e6);
        vm.expectEmit();
        emit Zap.ZappedIn(bob, vault, usdg, 10_000e6, 8_000e18);
        vm.prank(bob);
        uint256 shares = zap.zapIn(vault, usdg, 10_000e6, _noPermit(), swaps, 8_000e18, block.timestamp);

        assertEq(shares, 8_000e18); // $8,000 of a $1M vault
        assertEq(vault.balanceOf(bob), 8_000e18);
        assertEq(usdg.balanceOf(bob), 90_000e6);
        assertEq(stock.balanceOf(bob), 40e6); // leftover refunded
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(stock.balanceOf(address(zap)), 0);
        assertEq(usdg.allowance(address(zap), address(router)), 0);
        assertEq(weth.allowance(address(zap), address(vault)), 0);
    }

    function test_ZapInWithPermit2AndUnusedInputRefund() public {
        Zap.Call[] memory swaps = new Zap.Call[](2);
        swaps[0] = _swap(usdg, weth, 2_500e6);
        swaps[1] = _swap(usdg, stock, 2_500e6);
        vm.prank(bob);
        zap.zapIn(
            vault,
            usdg,
            6_000e6,
            Zap.Permit({nonce: 1, deadline: block.timestamp, signature: "ok"}),
            swaps,
            5_000e18,
            block.timestamp
        );
        assertEq(vault.balanceOf(bob), 5_000e18);
        assertEq(usdg.balanceOf(bob), 95_000e6); // 1,000 USDG pulled but not swapped came straight back
    }

    function test_ZapInGuards() public {
        Zap.Call[] memory swaps = new Zap.Call[](1);
        swaps[0] = _swap(usdg, weth, 2_500e6);

        vm.prank(bob);
        vm.expectRevert(Zap.Expired.selector);
        zap.zapIn(vault, usdg, 2_500e6, _noPermit(), swaps, 0, block.timestamp - 1);

        // A token (or anything else) that is not an allowlisted router cannot be called with user calldata.
        swaps[0].target = address(usdg);
        swaps[0].data = abi.encodeCall(IERC20.transferFrom, (bob, address(this), 1));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Zap.RouterNotAllowed.selector, address(usdg)));
        zap.zapIn(vault, usdg, 0, _noPermit(), swaps, 0, block.timestamp);

        // Vault slippage bubbles up.
        swaps[0] = _swap(usdg, weth, 2_500e6);
        vm.prank(bob);
        vm.expectRevert(IndexVault.Slippage.selector);
        zap.zapIn(vault, usdg, 2_500e6, _noPermit(), swaps, 1e18, block.timestamp); // only WETH arrives: scarcest stock binds at 0
    }

    function test_ZapOutRedeemsSwapsAndPays() public {
        Zap.Call[] memory inSwaps = new Zap.Call[](2);
        inSwaps[0] = _swap(usdg, weth, 5_000e6);
        inSwaps[1] = _swap(usdg, stock, 5_000e6);
        vm.prank(bob);
        zap.zapIn(vault, usdg, 10_000e6, _noPermit(), inSwaps, 10_000e18, block.timestamp);
        assertEq(vault.balanceOf(bob), 10_000e18);

        Zap.Call[] memory outSwaps = new Zap.Call[](2);
        outSwaps[0] = _swap(weth, usdg, 2e18);
        outSwaps[1] = _swap(stock, usdg, 100e6);
        vm.expectEmit();
        emit Zap.ZappedOut(bob, vault, 10_000e18, usdg, 10_000e6);
        vm.prank(bob);
        uint256 out = zap.zapOut(vault, 10_000e18, _noPermit(), outSwaps, usdg, 10_000e6, block.timestamp);
        assertEq(out, 10_000e6);
        assertEq(usdg.balanceOf(bob), 100_000e6); // round trip at fixed rates returns everything
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.balanceOf(address(zap)), 0);

        vm.prank(bob);
        vm.expectRevert(Zap.Slippage.selector);
        zap.zapOut(vault, 0, _noPermit(), new Zap.Call[](0), usdg, 1, block.timestamp);
    }
}
