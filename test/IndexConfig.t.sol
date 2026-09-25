// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IndexConfig} from "../src/IndexConfig.sol";

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
}
