// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {ChainlinkAdapter} from "../src/ChainlinkAdapter.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {IndexVault} from "../src/IndexVault.sol";
import {IndexVaultFactory} from "../src/IndexVaultFactory.sol";
import {MockFeed, MockToken} from "./Mocks.sol";

contract IndexVaultFactoryTest is Test {
    MockToken weth;
    MockToken stock;
    MockFeed feedWeth;
    MockFeed feedStock;
    IndexConfig config;
    IndexVaultFactory factory;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("WETH", 18);
        stock = new MockToken("STOCK", 6);
        feedWeth = new MockFeed(8, 2500e8);
        feedStock = new MockFeed(18, 50e18);
        config = new IndexConfig(address(this));
        factory = new IndexVaultFactory(config);
        weth.mint(alice, 200e18); // $500,000
        stock.mint(alice, 10_000e6); // $500,000
        vm.startPrank(alice);
        weth.approve(address(factory), type(uint256).max);
        stock.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    function _config(uint256 w0, uint256 w1) internal returns (IndexVault.Asset[] memory a) {
        a = new IndexVault.Asset[](2);
        a[0] = IndexVault.Asset({token: weth, valuer: new ChainlinkAdapter(weth, feedWeth, 90_000), weightBps: w0});
        a[1] = IndexVault.Asset({token: stock, valuer: new ChainlinkAdapter(stock, feedStock, 90_000), weightBps: w1});
    }

    function _seed(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        (s[0], s[1]) = (a, b);
    }

    function test_CreateDeploysSeedsAndRecords() public {
        IndexVault.Asset[] memory assets = _config(5000, 5000); // deploys adapters: build before arming cheatcodes
        IndexVault predicted = IndexVault(vm.computeCreateAddress(address(factory), 1));
        vm.expectEmit();
        emit IndexVaultFactory.VaultCreated(predicted, alice);
        vm.prank(alice);
        IndexVault vault = factory.create("Hood 50/50 Index", "INDEX", assets, _seed(200e18, 10_000e6));

        assertEq(address(vault), address(predicted));
        assertEq(address(vault.config()), address(config));
        assertEq(vault.creator(), alice); // the creator earns a cut of every rebalance
        assertEq(vault.balanceOf(alice), 1_000_000e18); // 1 INDEX per USD, straight to the creator
        assertEq(weth.balanceOf(address(vault)), 200e18);
        assertEq(stock.balanceOf(address(vault)), 10_000e6);
        assertEq(weth.balanceOf(address(factory)), 0); // nothing lingers in the factory
        assertEq(weth.allowance(address(factory), address(vault)), 0);
        assertEq(address(factory.vaults(0)), address(vault));
        assertEq(factory.all().length, 1);
    }

    function test_CreateRevertsOnBadConfigOrSeed() public {
        IndexVault.Asset[] memory badSum = _config(5000, 4000);
        IndexVault.Asset[] memory ok = _config(5000, 5000);

        vm.prank(alice);
        vm.expectRevert(IndexVault.InvalidWeights.selector);
        factory.create("x", "x", badSum, _seed(200e18, 10_000e6));

        vm.prank(alice);
        vm.expectRevert(IndexVault.ZeroAmount.selector); // every asset must be seeded
        factory.create("x", "x", ok, _seed(200e18, 0));

        vm.prank(alice);
        vm.expectRevert(stdError.indexOOBError); // one seed amount per asset
        factory.create("x", "x", ok, new uint256[](1));
    }
}
