// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract VaultTypes {
    enum WithdrawalStatus {
        None,
        Pending,
        Completed,
        Canceled
    }

    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint64 dstChainId;
        address token;
        uint256 amountNormalized;
        uint256 sharesLocked;
        WithdrawalStatus status;
    }

    struct ExternalVaultPositionView {
        address vault;
        address asset;
        uint256 shareBalance;
        uint256 assets;
        uint256 assetsNormalized;
    }
}
