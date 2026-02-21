// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./HakoStableGatewayTypes.sol";

library HakoStableGatewayStorage {
    struct Layout {
        mapping(address => bool) allowedDepositToken;
        mapping(address => uint8) depositTokenDecimals;
        uint256 minDepositNormalized;

        uint256 nextDepositId;
        uint256 nextWithdrawalId;

        mapping(uint256 => HakoStableGatewayTypes.GatewayWithdrawalRequest) withdrawalRequests;
        mapping(uint256 => bytes) withdrawalReceiverData;
        mapping(bytes32 => bool) processedTransferOut;

        mapping(address => bool) allowedExternalVault;
        mapping(address => address) externalVaultAsset;
        address[] externalVaultsList;
    }

    bytes32 internal constant STORAGE_SLOT = keccak256("hako.stable.gateway.storage");

    function layout() internal pure returns (Layout storage layout_) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            layout_.slot := slot
        }
    }
}
