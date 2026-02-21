// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../shared/VaultTypes.sol";

library HakoStableVaultStorage {
    struct Layout {
        mapping(address => bool) allowedDepositToken;
        mapping(address => uint8) depositTokenDecimals;

        mapping(uint64 => bool) allowedDestinationChain;
        mapping(uint64 => mapping(address => bool)) allowedDestinationToken;

        uint256 totalManagedAssets;
        uint256 nextDepositId;

        mapping(bytes32 => bool) processedDeposits;

        uint256 nextWithdrawalId;
        mapping(uint256 => VaultTypes.WithdrawalRequest) withdrawalRequests;
        mapping(uint256 => bytes) withdrawalReceiverData;
        mapping(bytes32 => bool) processedRemoteWithdrawalRequests;

        mapping(address => uint256) lockedShares;
        mapping(address => uint256) withdrawalNonces;

        uint256 performanceFeeBps;
        address feeRecipient;
        uint256 highWaterMark;
        uint256 minDepositNormalized;

        mapping(address => bool) allowedExternalVault;
        mapping(address => address) externalVaultAsset;
        address[] externalVaultsList;

        mapping(bytes32 => address) accountHashToPseudo;
        mapping(address => bytes32) pseudoToAccountHash;
        mapping(bytes32 => bool) processedTransferOut;
    }

    bytes32 internal constant STORAGE_SLOT = keccak256("hako.vault.storage");

    function layout() internal pure returns (Layout storage layout_) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            layout_.slot := slot
        }
    }
}
