// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../src/ChainlinkAdapter.sol";
import {IRebalancer, IndexVault} from "../src/IndexVault.sol";

contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeed is IAggregatorV3 {
    uint8 private immutable _decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        set(answer_);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function set(int256 answer_) public {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// Rebalancer that executes a precomputed list of pulls (out of the vault) and pushes (into the vault).
contract MockArb is IRebalancer {
    IndexVault public immutable vault;
    uint256 public allowanceDuringCallback; // allowance over asset 0 as seen inside onRebalance

    constructor(IndexVault vault_) {
        vault = vault_;
    }

    function run(uint256[] memory assetIds, uint256[] memory pulls, uint256[] memory pushes) external {
        vault.rebalance(assetIds, abi.encode(pulls, pushes));
    }

    function onRebalance(bytes calldata data) external override {
        require(msg.sender == address(vault), "not vault");
        (uint256[] memory pulls, uint256[] memory pushes) = abi.decode(data, (uint256[], uint256[]));
        (IERC20 first,,) = vault.assets(0);
        allowanceDuringCallback = first.allowance(address(vault), address(this));
        for (uint256 i; i < pulls.length; ++i) {
            (IERC20 token,,) = vault.assets(i);
            if (pulls[i] > 0) token.transferFrom(address(vault), address(this), pulls[i]);
            if (pushes[i] > 0) token.transfer(address(vault), pushes[i]);
        }
    }
}
