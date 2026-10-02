// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ChainlinkAdapter} from "../src/ChainlinkAdapter.sol";
import {IndexConfig} from "../src/IndexConfig.sol";
import {MockFeed, MockToken} from "./Mocks.sol";

contract IndexConfigTest is Test {
    IndexConfig config;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");

    function setUp() public {
        config = new IndexConfig(owner);
    }

    function test_DefaultsCapsAndSet() public {
        assertEq(config.thresholdBps(), 50);
        assertEq(config.incentiveBps(), 50);
        assertEq(config.creatorShareBps(), 1_000);
        assertEq(config.rebalanceInterval(), 18_000);
        assertEq(config.redeemFeeBps(), 0);
        assertEq(config.feeRecipient(), address(0));

        vm.startPrank(owner);
        vm.expectRevert(IndexConfig.OutOfRange.selector);
        config.set(1_001, 50, 1_000, 0, 0, address(0));
        vm.expectRevert(IndexConfig.OutOfRange.selector);
        config.set(50, 101, 1_000, 0, 0, address(0));
        vm.expectRevert(IndexConfig.OutOfRange.selector);
        config.set(50, 50, 5_001, 0, 0, address(0));
        vm.expectRevert(IndexConfig.OutOfRange.selector);
        config.set(50, 50, 1_000, 0, 501, treasury);
        vm.expectRevert(IndexConfig.OutOfRange.selector);
        config.set(50, 50, 1_000, 1_000_001, 0, address(0));
        vm.expectRevert(IndexConfig.OutOfRange.selector); // a fee needs a recipient
        config.set(50, 50, 1_000, 0, 100, address(0));

        vm.expectEmit();
        emit IndexConfig.ConfigSet(100, 25, 2_000, 500, 100, treasury);
        config.set(100, 25, 2_000, 500, 100, treasury);
        vm.stopPrank();
        assertEq(config.thresholdBps(), 100);
        assertEq(config.incentiveBps(), 25);
        assertEq(config.creatorShareBps(), 2_000);
        assertEq(config.rebalanceInterval(), 500);
        assertEq(config.redeemFeeBps(), 100);
        assertEq(config.feeRecipient(), treasury);
    }

    function test_OnlyOwnerAndTwoStepTransfer() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        config.set(50, 50, 1_000, 0, 0, address(0));

        vm.prank(owner);
        config.transferOwnership(treasury);
        assertEq(config.owner(), owner); // nothing changes until the new owner accepts
        vm.prank(treasury);
        config.acceptOwnership();
        assertEq(config.owner(), treasury);
    }

    function test_RegisterAssetIsOwnerOnlyDeterministicAndIdempotent() public {
        MockToken weth = new MockToken("WETH", 18);
        MockFeed feed = new MockFeed(8, 2500e8);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        config.registerAsset(weth, feed, 90_000);

        vm.startPrank(owner);
        ChainlinkAdapter a = config.registerAsset(weth, feed, 90_000);
        assertEq(a.token(), address(weth));
        assertEq(address(config.valuerOf(address(weth))), address(a));
        assertEq(config.registeredAssets().length, 1);

        ChainlinkAdapter again = config.registerAsset(weth, feed, 90_000); // same triple: same adapter, no new entry
        assertEq(address(again), address(a));
        assertEq(config.registeredAssets().length, 1);

        MockFeed otherFeed = new MockFeed(8, 2600e8);
        ChainlinkAdapter b = config.registerAsset(weth, otherFeed, 3_600); // new triple: new adapter, same list
        assertTrue(address(b) != address(a));
        assertEq(address(config.valuerOf(address(weth))), address(b));
        assertEq(config.registeredAssets().length, 1);
        vm.stopPrank();
    }
}
