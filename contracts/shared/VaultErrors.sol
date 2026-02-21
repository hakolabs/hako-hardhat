// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract VaultErrors {
    error ZeroAddress();
    error AmountZero();
    error BelowMinDeposit();
    error DepositAlreadyProcessed(bytes32 depositId);
    error RemoteWithdrawalAlreadyProcessed(bytes32 remoteRequestId);
    error OperationAlreadyProcessed(bytes32 operationId);
    error TokenNotAllowed(address token);
    error DestinationChainNotAllowed(uint64 dstChainId);
    error DestinationTokenNotAllowed(uint64 dstChainId, address token);
    error DecimalsTooHigh();
    error ZeroShares();
    error VaultEmpty();
    error SharesExceedMax();
    error InsufficientUnlockedShares();
    error WithdrawalNotPending(uint256 requestId);
    error ManagedAssetsUnderflow();
    error ExternalVaultUnknown(address vault);
    error ExternalVaultNotAllowed(address vault);
    error ExternalVaultAssetMismatch(address vault, address cachedAsset, address liveAsset);
    error InvalidChainId();
    error InvalidAccountId();
    error InvalidTokenId();
    error InvalidReceiverData();
    error ExternalReceiverNotAllowed();
    error FeeTooHigh();
    error InvalidWithdrawalNonce(uint256 expected, uint256 actual);
    error RedeemAmountBelowMinimum(uint256 amountNormalized, uint256 minAmountNormalized);
}
