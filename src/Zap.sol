// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IndexConfig} from "./IndexConfig.sol";
import {IndexVault} from "./IndexVault.sol";

/// @dev Uniswap Permit2 signature transfers, the only part this contract uses.
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @title Zap - one call from a single token (typically USDG) into an index, and back out
/// @notice Stateless periphery: it holds nothing between transactions and has no owner. The caller describes the
///         swaps as calldata for routers the IndexConfig owner has allowlisted; the zap approves each router for
///         exactly the stated input, runs the call, revokes, deposits whatever it then holds of the vault's assets
///         (or redeems and sells them), and refunds every leftover to the caller. Because it never delegatecalls and
///         only ever pays routers from its own transient balance, a caller can only ever move their own funds.
contract Zap is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Address for address;

    /// @notice One swap: approve `target` for `amountIn` of `tokenIn`, then call it with `data`.
    struct Call {
        address target;
        IERC20 tokenIn;
        uint256 amountIn;
        bytes data;
    }

    /// @notice Permit2 signature transfer for the input token; an empty `signature` means a plain ERC-20 allowance.
    struct Permit {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    IndexConfig public immutable config;
    IPermit2 public immutable permit2;

    event ZappedIn(address indexed user, IndexVault indexed vault, IERC20 tokenIn, uint256 amountIn, uint256 shares);
    event ZappedOut(address indexed user, IndexVault indexed vault, uint256 shares, IERC20 tokenOut, uint256 amountOut);

    error RouterNotAllowed(address target);
    error Expired();
    error Slippage();

    constructor(IndexConfig config_, IPermit2 permit2_) {
        config = config_;
        permit2 = permit2_;
    }

    /// @notice Turn `amountIn` of `tokenIn` into INDEX of `vault`: pull, swap along `swaps`, deposit every vault asset
    ///         the zap now holds, send the shares to the caller and refund all leftovers.
    function zapIn(
        IndexVault vault,
        IERC20 tokenIn,
        uint256 amountIn,
        Permit calldata permit,
        Call[] calldata swaps,
        uint256 minShares,
        uint256 deadline
    ) external nonReentrant returns (uint256 shares) {
        if (block.timestamp > deadline) revert Expired();
        _pull(tokenIn, amountIn, permit);
        _swap(swaps);
        uint256 n = vault.assetCount();
        IERC20[] memory tokens = new IERC20[](n);
        uint256[] memory maxAmounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            (tokens[i],,) = vault.assets(i);
            maxAmounts[i] = tokens[i].balanceOf(address(this));
            tokens[i].forceApprove(address(vault), maxAmounts[i]);
        }
        (shares,) = vault.deposit(maxAmounts, minShares, msg.sender);
        for (uint256 i; i < n; ++i) {
            tokens[i].forceApprove(address(vault), 0);
            _refund(tokens[i]);
        }
        _refund(tokenIn);
        emit ZappedIn(msg.sender, vault, tokenIn, amountIn, shares);
    }

    /// @notice Turn `shares` of `vault` into `tokenOut`: pull the shares, redeem, swap each asset along `swaps`, send
    ///         at least `minOut` of `tokenOut` to the caller and refund all leftovers.
    function zapOut(
        IndexVault vault,
        uint256 shares,
        Permit calldata permit,
        Call[] calldata swaps,
        IERC20 tokenOut,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        _pull(IERC20(address(vault)), shares, permit);
        vault.redeem(shares, address(this));
        _swap(swaps);
        amountOut = tokenOut.balanceOf(address(this));
        if (amountOut < minOut) revert Slippage();
        tokenOut.safeTransfer(msg.sender, amountOut);
        uint256 n = vault.assetCount();
        for (uint256 i; i < n; ++i) {
            (IERC20 t,,) = vault.assets(i);
            _refund(t);
        }
        emit ZappedOut(msg.sender, vault, shares, tokenOut, amountOut);
    }

    function _pull(IERC20 token, uint256 amount, Permit calldata p) private {
        if (p.signature.length == 0) {
            token.safeTransferFrom(msg.sender, address(this), amount);
            return;
        }
        permit2.permitTransferFrom(
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({token: address(token), amount: amount}),
                nonce: p.nonce,
                deadline: p.deadline
            }),
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            msg.sender,
            p.signature
        );
    }

    function _swap(Call[] calldata swaps) private {
        for (uint256 i; i < swaps.length; ++i) {
            Call calldata c = swaps[i];
            if (!config.isRouter(c.target)) revert RouterNotAllowed(c.target);
            c.tokenIn.forceApprove(c.target, c.amountIn);
            c.target.functionCall(c.data);
            c.tokenIn.forceApprove(c.target, 0);
        }
    }

    function _refund(IERC20 token) private {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(msg.sender, bal);
    }
}
