// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Prices one ERC-20 in USD. Bound to a single token at deployment. IndexVault keeps its valuers
///         immutable and swaps price sources only by creating a successor vault.
interface IValuer {
    /// @notice The token this valuer prices.
    function token() external view returns (address);

    /// @notice USD value (18 decimals) of `amount` raw units of the token. Must revert when the source is
    ///         stale, invalid or closed; the vault then refuses to rebalance or to price a first deposit.
    function valueOf(uint256 amount) external view returns (uint256);
}
