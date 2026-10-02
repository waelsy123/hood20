// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ChainlinkAdapter, IAggregatorV3} from "./ChainlinkAdapter.sol";
import {IValuer} from "./IValuer.sol";

/// @title IndexConfig - owner-managed settings and the curated asset registry shared by every IndexVault
/// @notice Deployed once, handed to the factory and from there to every vault, which read the settings live. Hard
///         caps bound what the owner can ever set, so vault users know the worst case up front. The owner also
///         registers which assets vaults may hold: each registration deploys an immutable ChainlinkAdapter for the
///         (token, feed, maxStale) triple and points the token at it. Re-registering a token only affects vaults
///         created afterwards; existing vaults keep the valuer they launched with.
contract IndexConfig is Ownable2Step {
    uint256 public constant MAX_THRESHOLD_BPS = 1_000; // rebalances gated by at most 10% drift
    uint256 public constant MAX_INCENTIVE_BPS = 100; // a rebalancer keeps at most 1% of the misplaced value
    uint256 public constant MAX_CREATOR_SHARE_BPS = 5_000; // an index creator earns at most half of what rebalancers keep
    uint256 public constant MAX_REDEEM_FEE_BPS = 500; // at most 5% of redeemed shares
    uint256 public constant MAX_REBALANCE_INTERVAL = 1_000_000; // blocks (about 28 h at Robinhood Chain's 0.1 s blocks)

    uint256 public thresholdBps = 50; // rebalance only when an asset is >= 0.5% of NAV off target
    uint256 public incentiveBps = 50; // holders pay at most 0.5% of the misplaced value per rebalance
    uint256 public creatorShareBps = 1_000; // the index creator earns 10% of what the rebalancer keeps, as INDEX
    uint256 public rebalanceInterval = 18_000; // min blocks between two rebalances of a vault (~30 min); 0 = none
    uint256 public redeemFeeBps; // share of redeemed INDEX kept as a fee; 0 = disabled
    address public feeRecipient; // receives the fee as INDEX

    /// @notice Valuer new vaults must use for a token; zero means the asset is not allowed.
    mapping(address token => IValuer) public valuerOf;
    /// @notice Every token ever registered, for discovery (check `valuerOf` for the current valuer).
    address[] public registered;
    /// @notice DEX routers the Zap may call with caller-supplied calldata.
    mapping(address router => bool) public isRouter;

    event ConfigSet(
        uint256 thresholdBps,
        uint256 incentiveBps,
        uint256 creatorShareBps,
        uint256 rebalanceInterval,
        uint256 redeemFeeBps,
        address indexed feeRecipient
    );

    event AssetRegistered(address indexed token, address indexed valuer, address feed, uint256 maxStale);
    event RouterSet(address indexed router, bool allowed);

    error OutOfRange();

    constructor(address owner_) Ownable(owner_) {}

    function set(
        uint256 thresholdBps_,
        uint256 incentiveBps_,
        uint256 creatorShareBps_,
        uint256 rebalanceInterval_,
        uint256 redeemFeeBps_,
        address feeRecipient_
    ) external onlyOwner {
        if (
            thresholdBps_ > MAX_THRESHOLD_BPS || incentiveBps_ > MAX_INCENTIVE_BPS
                || creatorShareBps_ > MAX_CREATOR_SHARE_BPS || rebalanceInterval_ > MAX_REBALANCE_INTERVAL
                || redeemFeeBps_ > MAX_REDEEM_FEE_BPS || (redeemFeeBps_ > 0 && feeRecipient_ == address(0))
        ) revert OutOfRange();
        (thresholdBps, incentiveBps, creatorShareBps, rebalanceInterval, redeemFeeBps, feeRecipient) =
        (thresholdBps_, incentiveBps_, creatorShareBps_, rebalanceInterval_, redeemFeeBps_, feeRecipient_);
        emit ConfigSet(thresholdBps_, incentiveBps_, creatorShareBps_, rebalanceInterval_, redeemFeeBps_, feeRecipient_);
    }

    /// @notice Allow `token` in new vaults, priced by a fresh immutable ChainlinkAdapter over `feed`. Deterministic:
    ///         the same triple always yields the same adapter address, so registering it twice is a no-op deploy.
    function registerAsset(IERC20Metadata token, IAggregatorV3 feed, uint256 maxStale)
        external
        onlyOwner
        returns (ChainlinkAdapter adapter)
    {
        bytes32 salt = keccak256(abi.encode(token, feed, maxStale));
        address predicted = Create2.computeAddress(
            salt, keccak256(abi.encodePacked(type(ChainlinkAdapter).creationCode, abi.encode(token, feed, maxStale)))
        );
        adapter = predicted.code.length > 0
            ? ChainlinkAdapter(predicted)
            : new ChainlinkAdapter{salt: salt}(token, feed, maxStale);
        if (address(valuerOf[address(token)]) == address(0)) registered.push(address(token));
        valuerOf[address(token)] = adapter;
        emit AssetRegistered(address(token), address(adapter), address(feed), maxStale);
    }

    /// @notice Allow or disallow a DEX router for the Zap.
    function setRouter(address router, bool allowed) external onlyOwner {
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function registeredAssets() external view returns (address[] memory) {
        return registered;
    }
}
