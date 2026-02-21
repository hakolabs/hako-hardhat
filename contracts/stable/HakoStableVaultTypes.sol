// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../shared/VaultTypes.sol";
import "../shared/VaultErrors.sol";
import "../shared/VaultEvents.sol";

abstract contract HakoStableVaultTypes is VaultTypes, VaultErrors, VaultEvents {}
