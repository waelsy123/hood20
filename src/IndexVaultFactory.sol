// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IndexConfig} from "./IndexConfig.sol";
import {IndexVault} from "./IndexVault.sol";

/// @title IndexVaultFactory - deploys IndexVaults and seeds them in the same transaction
/// @notice Seeding atomically means nobody can front-run a launch with a dust deposit that fixes a skewed
///         initial mix. The factory has no owner and holds nothing between transactions.
contract IndexVaultFactory {
    using SafeERC20 for IERC20;

    IndexConfig public immutable config; // handed to every vault it creates
    IndexVault[] public vaults;

    event VaultCreated(IndexVault indexed vault, address indexed creator);

    constructor(IndexConfig config_) {
        config = config_;
    }

    /// @notice Deploy a vault and make its first deposit: `seed[i]` raw units of `assets_[i].token` are pulled
    ///         from the caller (approve the factory first) and the minted INDEX goes to the caller.
    function create(
        string calldata name,
        string calldata symbol,
        IndexVault.Asset[] calldata assets_,
        uint256[] calldata seed
    ) external returns (IndexVault vault) {
        vault = new IndexVault(name, symbol, assets_, config);
        vaults.push(vault);
        for (uint256 i; i < assets_.length; ++i) {
            assets_[i].token.safeTransferFrom(msg.sender, address(this), seed[i]);
            assets_[i].token.forceApprove(address(vault), seed[i]);
        }
        vault.deposit(seed, 0, msg.sender);
        emit VaultCreated(vault, msg.sender);
    }

    function all() external view returns (IndexVault[] memory) {
        return vaults;
    }
}
