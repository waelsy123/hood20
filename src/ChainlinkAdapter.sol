// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IValuer} from "./IValuer.sol";

/// @dev The part of Chainlink's AggregatorV3Interface this adapter reads.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkAdapter - IValuer over a Chainlink USD feed
/// @notice One immutable adapter per (token, feed). Rejects non-positive answers and answers older than
///         `maxStale`. Robinhood Chain's equity feeds publish nothing over weekends and US holidays, so a
///         `maxStale` of about 25 hours makes vaults fail closed while the 24/5 market is shut; raising it past
///         the weekend gap would let a vault settle at Friday prices.
contract ChainlinkAdapter is IValuer {
    uint256 public constant MAX_STALE_CAP = 7 days;

    IAggregatorV3 public immutable feed;
    uint256 public immutable maxStale; // seconds an answer stays acceptable
    uint256 public immutable scale; // 10 ** (token decimals + feed decimals)
    address private immutable _token;

    error BadConfig();
    error BadPrice();
    error StalePrice();

    constructor(IERC20Metadata token_, IAggregatorV3 feed_, uint256 maxStale_) {
        if (maxStale_ == 0 || maxStale_ > MAX_STALE_CAP) revert BadConfig();
        _token = address(token_);
        feed = feed_;
        maxStale = maxStale_;
        scale = 10 ** (token_.decimals() + feed_.decimals());
    }

    function token() external view returns (address) {
        return _token;
    }

    function valueOf(uint256 amount) external view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (updatedAt + maxStale < block.timestamp) revert StalePrice();
        // forge-lint: disable-next-line(unsafe-typecast)
        return Math.mulDiv(amount * uint256(answer), 1e18, scale); // safe cast: answer > 0 was checked above
    }
}
