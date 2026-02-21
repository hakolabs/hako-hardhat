// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./HakoStableVaultStorage.sol";
import "./HakoStableVaultTypes.sol";

abstract contract HakoStableVaultRegistry is HakoStableVaultTypes {
    function _registerNonEvmAccount(uint64 chainId, string memory accountId) internal returns (address pseudoAddress) {
        (bytes32 accountHash, address derivedPseudoAddress) = _computePseudoAddress(chainId, accountId);
        pseudoAddress = derivedPseudoAddress;

        HakoStableVaultStorage.Layout storage layout_ = HakoStableVaultStorage.layout();
        address current = layout_.accountHashToPseudo[accountHash];
        bool newlyRegistered;
        if (current == address(0)) {
            layout_.accountHashToPseudo[accountHash] = pseudoAddress;
            layout_.pseudoToAccountHash[pseudoAddress] = accountHash;
            newlyRegistered = true;
        } else {
            pseudoAddress = current;
            newlyRegistered = false;
        }

        emit NonEvmAccountRegistered(chainId, accountId, accountHash, pseudoAddress, newlyRegistered);
    }

    function _computePseudoAddress(uint64 chainId, string memory accountId)
        internal
        pure
        returns (bytes32 accountHash, address pseudoAddress)
    {
        if (chainId == 0) revert InvalidChainId();
        if (bytes(accountId).length == 0) revert InvalidAccountId();

        bytes memory base = abi.encodePacked("hako:", chainId, ":", accountId);
        accountHash = keccak256(base);
        pseudoAddress = address(uint160(uint256(accountHash)));

        if (pseudoAddress == address(0)) {
            bytes32 fallbackHash = keccak256(abi.encodePacked(base, ":1"));
            pseudoAddress = address(uint160(uint256(fallbackHash)));
        }
    }

    function _computeVirtualTokenAddress(uint64 chainId, string memory tokenId)
        internal
        pure
        returns (bytes32 tokenHash, address virtualToken)
    {
        if (chainId == 0) revert InvalidChainId();
        if (bytes(tokenId).length == 0) revert InvalidTokenId();

        bytes memory base = abi.encodePacked("hako:token:", chainId, ":", tokenId);
        tokenHash = keccak256(base);
        virtualToken = address(uint160(uint256(tokenHash)));

        if (virtualToken == address(0)) {
            bytes32 fallbackHash = keccak256(abi.encodePacked(base, ":1"));
            virtualToken = address(uint160(uint256(fallbackHash)));
        }
    }

    function _bytesToAddress(bytes memory data) internal pure returns (address addr) {
        if (data.length != 20) {
            return address(0);
        }

        assembly {
            addr := shr(96, mload(add(data, 32)))
        }
    }
}
