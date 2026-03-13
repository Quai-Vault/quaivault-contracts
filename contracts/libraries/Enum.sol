// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.22; // locked to match production compiler version

/**
 * @title Enum - Collection of enums for Zodiac compatibility
 * @author Gnosis Team (adapted for Quai-Vault)
 * @notice Provides Operation enum for module execution (Zodiac IAvatar standard)
 */
library Enum {
    /// @notice Operation type for module execution
    /// @dev Used by execTransactionFromModule to specify call type
    enum Operation {
        Call,        // 0 - Standard external call
        DelegateCall // 1 - Executes code in context of this contract
    }
}
