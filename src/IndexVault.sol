// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IndexConfig} from "./IndexConfig.sol";
import {IValuer} from "./IValuer.sol";

/// @dev Implemented by rebalancers. IndexVault.rebalance calls it once pull-rights have been granted.
interface IRebalancer {
    function onRebalance(bytes calldata data) external;
}

/// @title IndexVault - permissionless fixed-weight index
/// @notice Custodies N ERC-20s at fixed target weights (summing to 100%), values each through its own
///         immutable IValuer (see ChainlinkAdapter) and never trades:
///  - deposits and redemptions are pro-rata in ALL assets, so they never change the mix and never
///    depend on oracle latency (only the very first deposit is priced: 1 INDEX = 1 USD);
///  - once any asset drifts past the configured threshold, any contract may rebalance: it names the
///    assets it wants pull-rights over, holds unlimited allowance on them while its callback runs, does
///    the exchange its own way (inventory, DEX, flash swaps) and keeps up to the configured share of
///    the misplaced value. Allowances are revoked afterwards and the call reverts unless the vault is
///    balanced again, so the pull-rights can never drain it and a mispriced source can cost at most a
///    fraction of the current imbalance.
///  Threshold, incentive, minimum block interval between rebalances and an optional redeem fee are read
///  live from a shared IndexConfig whose owner can change them within hard caps. The vault itself has no
///  owner and no upgradeability; changing a price source means creating a successor vault.
contract IndexVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Asset {
        IERC20 token;
        IValuer valuer; // prices `token` in USD (18 decimals); fixed for the vault's life
        uint256 weightBps; // target share of NAV; all weights must sum to 10_000
    }

    uint256 private constant BPS = 10_000;

    /// @notice Shared settings: drift threshold, rebalance incentive, rebalance interval, redeem fee.
    IndexConfig public immutable config;
    /// @notice The portfolio, fixed at construction.
    Asset[] public assets;
    /// @notice Block of the last successful rebalance; the configured interval must pass before the next one.
    uint256 public lastRebalanceBlock;

    event Deposit(address indexed sender, address indexed to, uint256[] amounts, uint256 shares);
    event Redeem(address indexed sender, address indexed to, uint256[] amounts, uint256 shares, uint256 fee);
    event Rebalanced(address indexed rebalancer, uint256 nav);

    error InvalidWeights();
    error DuplicateAsset();
    error WrongValuer();
    error LengthMismatch();
    error ZeroAmount();
    error Slippage();
    error BelowThreshold();
    error TooSoon();
    error OffTarget();

    constructor(string memory name_, string memory symbol_, Asset[] memory assets_, IndexConfig config_)
        ERC20(name_, symbol_)
    {
        config = config_;
        uint256 totalWeight;
        for (uint256 i; i < assets_.length; ++i) {
            Asset memory a = assets_[i];
            if (a.weightBps == 0) revert InvalidWeights();
            if (a.valuer.token() != address(a.token)) revert WrongValuer();
            for (uint256 j; j < i; ++j) {
                if (address(assets_[j].token) == address(a.token)) revert DuplicateAsset();
            }
            totalWeight += a.weightBps;
            assets.push(a);
        }
        if (totalWeight != BPS) revert InvalidWeights();
    }

    // ─────────────────────────────── deposit / redeem (pro-rata, oracle-free) ───────────────────────────────

    /// @notice Deposit every asset in the vault's current ratio and mint INDEX to `to`.
    /// @dev Pulls at most `maxAmounts[i]` of asset i; whichever cap binds sets the share count. When the vault
    ///      is empty the caller sets the initial mix (all assets required) and gets one INDEX per USD deposited.
    function deposit(uint256[] calldata maxAmounts, uint256 minShares, address to)
        external
        nonReentrant
        returns (uint256 shares, uint256[] memory amounts)
    {
        uint256 n = assets.length;
        if (maxAmounts.length != n) revert LengthMismatch();
        uint256 supply = totalSupply();
        if (supply == 0) {
            for (uint256 i; i < n; ++i) {
                if (maxAmounts[i] == 0) revert ZeroAmount();
                shares += assets[i].valuer.valueOf(maxAmounts[i]);
            }
        } else {
            shares = type(uint256).max;
            for (uint256 i; i < n; ++i) {
                shares = Math.min(shares, Math.mulDiv(maxAmounts[i], supply, _balance(assets[i])));
            }
        }
        if (shares == 0 || shares < minShares) revert Slippage();
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            // Tokens are distinct, so transfers of earlier assets in this loop do not touch this balance.
            amounts[i] =
                supply == 0 ? maxAmounts[i] : Math.mulDiv(shares, _balance(assets[i]), supply, Math.Rounding.Ceil);
            assets[i].token.safeTransferFrom(msg.sender, address(this), amounts[i]);
        }
        _mint(to, shares);
        emit Deposit(msg.sender, to, amounts, shares);
    }

    /// @notice Burn `shares` and send the pro-rata slice of every asset to `to`. When the config sets a redeem
    ///         fee, that slice of `shares` goes to the fee recipient as INDEX instead of being redeemed.
    function redeem(uint256 shares, address to) external nonReentrant returns (uint256[] memory amounts) {
        uint256 fee = shares * config.redeemFeeBps() / BPS;
        if (fee > 0) {
            _transfer(msg.sender, config.feeRecipient(), fee);
            shares -= fee;
        }
        uint256 n = assets.length;
        uint256 supply = totalSupply();
        _burn(msg.sender, shares);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = Math.mulDiv(shares, _balance(assets[i]), supply);
            assets[i].token.safeTransfer(to, amounts[i]);
        }
        emit Redeem(msg.sender, to, amounts, shares, fee);
    }

    // ─────────────────────────────────── permissionless rebalancing ───────────────────────────────────

    /// @dev allow max -> body -> allow zero -> require the vault balanced with at most the incentive gone.
    modifier lending(uint256[] calldata assetIds) {
        uint256 minNav = _minNavAfter();
        for (uint256 i; i < assetIds.length; ++i) {
            assets[assetIds[i]].token.forceApprove(msg.sender, type(uint256).max);
        }
        _;
        for (uint256 i; i < assetIds.length; ++i) {
            assets[assetIds[i]].token.forceApprove(msg.sender, 0);
        }
        _requireBalanced(minNav);
    }

    /// @notice Rebalance the vault your own way. While `onRebalance(data)` runs on the caller, the caller holds
    ///         unlimited allowance over `assetIds`: pull the excess of overweight assets, send in the shortfall
    ///         of underweight ones, keep up to the configured incentive share of the misplaced value. Allowed once
    ///         some asset is the configured threshold off target; reverts unless the vault ends balanced.
    function rebalance(uint256[] calldata assetIds, bytes calldata data) external nonReentrant lending(assetIds) {
        IRebalancer(msg.sender).onRebalance(data);
    }

    // ───────────────────────────────────────────── views ─────────────────────────────────────────────

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    /// @notice USD value (18 decimals) of every holding at current prices, and their sum (NAV).
    function snapshot() public view returns (uint256[] memory vals, uint256 nav) {
        uint256 n = assets.length;
        vals = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            vals[i] = assets[i].valuer.valueOf(_balance(assets[i]));
            nav += vals[i];
        }
    }

    /// @notice Largest distance of any asset from its target, in basis points of NAV.
    function deviationBps() external view returns (uint256 maxBps) {
        (uint256[] memory vals, uint256 nav) = snapshot();
        (maxBps,) = _gaps(vals, nav);
    }

    // ──────────────────────────────────────────── internals ────────────────────────────────────────────

    /// @dev Requires the configured block interval since the last rebalance and the drift threshold to be met,
    ///      and returns the lowest NAV a rebalance may leave behind: current NAV minus the configured incentive
    ///      share of the value sitting above target.
    function _minNavAfter() private view returns (uint256) {
        if (lastRebalanceBlock != 0 && block.number < lastRebalanceBlock + config.rebalanceInterval()) {
            revert TooSoon();
        }
        (uint256[] memory vals, uint256 nav) = snapshot();
        (uint256 maxBps, uint256 misplaced) = _gaps(vals, nav);
        if (maxBps < config.thresholdBps()) revert BelowThreshold();
        return nav - misplaced * config.incentiveBps() / BPS;
    }

    /// @dev Reverts unless every asset is within 0.01% of NAV of its target and NAV is at least `minNav`.
    function _requireBalanced(uint256 minNav) private {
        (uint256[] memory vals, uint256 nav) = snapshot();
        (uint256 maxBps,) = _gaps(vals, nav);
        if (nav < minNav || maxBps != 0) revert OffTarget();
        lastRebalanceBlock = block.number;
        emit Rebalanced(msg.sender, nav);
    }

    /// @dev Largest gap from target in basis points of NAV, and the total value sitting above target.
    function _gaps(uint256[] memory vals, uint256 nav) private view returns (uint256 maxBps, uint256 misplaced) {
        for (uint256 i; nav != 0 && i < vals.length; ++i) {
            uint256 target = nav * assets[i].weightBps / BPS;
            uint256 gap = vals[i] > target ? vals[i] - target : target - vals[i];
            if (vals[i] > target) misplaced += gap;
            maxBps = Math.max(maxBps, gap * BPS / nav);
        }
    }

    function _balance(Asset storage a) private view returns (uint256) {
        return a.token.balanceOf(address(this));
    }
}
