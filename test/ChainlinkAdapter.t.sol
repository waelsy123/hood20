// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainlinkAdapter} from "../src/ChainlinkAdapter.sol";
import {MockFeed, MockToken} from "./Mocks.sol";

contract ChainlinkAdapterTest is Test {
    MockToken weth;
    MockToken stock;
    MockFeed feedWeth;
    MockFeed feedStock;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockToken("WETH", 18);
        stock = new MockToken("STOCK", 6);
        feedWeth = new MockFeed(8, 2500e8);
        feedStock = new MockFeed(18, 50e18);
    }

    function test_ValueOfHandlesTokenAndFeedDecimals() public {
        ChainlinkAdapter a = new ChainlinkAdapter(weth, feedWeth, 90_000);
        assertEq(a.token(), address(weth));
        assertEq(a.scale(), 1e26);
        assertEq(a.valueOf(2e18), 5_000e18); // 2 WETH at $2,500

        ChainlinkAdapter b = new ChainlinkAdapter(stock, feedStock, 90_000);
        assertEq(b.scale(), 1e24);
        assertEq(b.valueOf(1_500_000), 75e18); // 1.5 shares at $50
    }

    function test_RejectsStaleBadAndMisconfigured() public {
        ChainlinkAdapter a = new ChainlinkAdapter(weth, feedWeth, 90_000);
        vm.warp(block.timestamp + 90_000); // exactly at the limit is still fine
        a.valueOf(1e18);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ChainlinkAdapter.StalePrice.selector);
        a.valueOf(1e18);

        feedWeth.set(0);
        vm.expectRevert(ChainlinkAdapter.BadPrice.selector);
        a.valueOf(1e18);

        vm.expectRevert(ChainlinkAdapter.BadConfig.selector);
        new ChainlinkAdapter(weth, feedWeth, 0);
        vm.expectRevert(ChainlinkAdapter.BadConfig.selector);
        new ChainlinkAdapter(weth, feedWeth, 7 days + 1);
    }
}
