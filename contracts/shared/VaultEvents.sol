// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract VaultEvents {
    event AllowedDepositTokenUpdated(address indexed token, uint8 decimals, bool allowed);
    event DestinationChainUpdated(uint64 indexed dstChainId, bool allowed);
    event DestinationAssetUpdated(uint64 indexed dstChainId, address indexed token, bool allowed);

    event NonEvmAccountRegistered(
        uint64 chainId,
        string accountId,
        bytes32 indexed accountHash,
        address indexed pseudoAddress,
        bool newlyRegistered
    );

    event DepositRecorded(
        bytes32 indexed depositId,
        address indexed receiver,
        uint256 amountNormalized,
        uint256 sharesMinted,
        bool remote
    );

    event NonEvmDepositRecorded(
        bytes32 indexed depositId,
        uint64 chainId,
        string accountId,
        address indexed pseudoReceiver,
        uint256 amountNormalized,
        uint256 sharesMinted
    );

    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed owner,
        uint64 dstChainId,
        address token,
        bytes receiver,
        uint256 amountNormalized,
        uint256 sharesLocked
    );

    event RemoteWithdrawalRequestRecorded(
        bytes32 indexed remoteRequestId,
        uint256 indexed requestId,
        address indexed owner,
        uint64 dstChainId,
        address token,
        bytes receiver,
        uint256 amountNormalized,
        uint256 sharesLocked
    );

    event WithdrawalCompleted(
        uint256 indexed requestId,
        address indexed owner,
        uint256 sharesBurned,
        uint256 amountNormalized
    );

    event WithdrawalCanceled(uint256 indexed requestId, address indexed owner, uint256 sharesUnlocked);
    event TransferOut(
        bytes32 indexed operationId,
        address indexed token,
        address indexed to,
        uint256 amountToken,
        uint256 amountNormalized,
        bytes32 reasonCode
    );

    event ManagedAssetsAdjusted(int256 deltaNormalized, uint256 newTotal);
    event PerformanceFeeUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed newRecipient);
    event MinDepositUpdated(uint256 oldMinDeposit, uint256 newMinDeposit);
    event PerformanceFeeCollected(uint256 profit, uint256 feeShares, address indexed recipient);
    event HighWaterMarkUpdated(uint256 newHighWaterMark);
    event ExternalVaultAllowlistUpdated(address indexed vault, bool allowed);

    event ExternalVaultCached(address indexed vault, address indexed asset, uint8 assetDecimals);
    event ExternalVaultDeposit(address indexed vault, address indexed asset, uint256 assets, uint256 sharesMinted);
    event ExternalVaultWithdraw(
        address indexed vault,
        address indexed asset,
        uint256 assets,
        uint256 sharesBurned,
        address indexed receiver
    );
    event ExternalVaultRedeem(
        address indexed vault,
        address indexed asset,
        uint256 sharesBurned,
        uint256 assetsReceived,
        address indexed receiver
    );
}
