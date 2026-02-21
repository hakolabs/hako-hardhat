// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title HakoProxy
 * @notice ERC1967 Proxy used for deploying UUPS upgradeable Hako vaults.
 * @dev This contract simply re-exports OpenZeppelin's ERC1967Proxy so that
 *      Hardhat can compile and Ignition can deploy it by name.
 *      The actual upgrade logic is in the UUPS implementation contracts.
 */
contract HakoProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory _data) ERC1967Proxy(implementation, _data) {}
}

