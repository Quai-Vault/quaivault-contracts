// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SlotTamper - Test helper for BB-L-4 ERC1967 slot protection test
 * @dev When delegatecalled, overwrites the ERC1967 implementation slot
 */
contract SlotTamper {
    /// @notice Overwrites the ERC1967 implementation slot with a malicious address
    function tamperImplementationSlot() external {
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        address malicious = address(0xdead);
        assembly {
            sstore(slot, malicious)
        }
    }
}
