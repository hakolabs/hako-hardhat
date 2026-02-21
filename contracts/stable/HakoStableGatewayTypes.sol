// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../shared/VaultTypes.sol";
import "../shared/VaultErrors.sol";

abstract contract HakoStableGatewayTypes is VaultTypes, VaultErrors {
    enum GatewayWithdrawalStatus {
        None,
        Pending,
        Completed,
        Canceled
    }

    struct GatewayWithdrawalRequest {
        address owner;
        address receiver;
        address token;
        uint256 amountToken;
        uint256 amountNormalized;
        GatewayWithdrawalStatus status;
    }

    event GatewayAllowedDepositTokenUpdated(address indexed token, uint8 decimals, bool allowed);
    event GatewayMinDepositUpdated(uint256 oldMinDeposit, uint256 newMinDeposit);

    event GatewayDepositRecorded(
        bytes32 indexed depositId,
        address indexed sender,
        address indexed token,
        uint256 amountToken,
        uint256 amountNormalized,
        address receiver
    );

    event GatewayWithdrawalRequested(
        uint256 indexed requestId,
        address indexed owner,
        address indexed receiver,
        address token,
        uint256 amountToken,
        uint256 amountNormalized
    );

    event GatewayWithdrawalCompleted(uint256 indexed requestId, address indexed receiver, address indexed token, uint256 amountToken);

    event GatewayWithdrawalCanceled(uint256 indexed requestId, address indexed token, uint256 amountToken);

    event GatewayTransferOut(
        bytes32 indexed operationId,
        address indexed token,
        address indexed to,
        uint256 amountToken,
        bytes32 reasonCode
    );

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
