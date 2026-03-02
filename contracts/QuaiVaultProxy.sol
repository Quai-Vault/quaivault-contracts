// SPDX-License-Identifier: MIT
pragma solidity 0.8.22; // I-5: locked to match production compiler version

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title QuaiVaultProxy
 * @dev Constructor-based proxy for each QuaiVault instance.
 *      Uses ERC1967 storage slots for the implementation address.
 *      The receive() function handles plain native QUAI transfers without DELEGATECALL,
 *      solving the Quai Network access-list issue where ERC-1167 clones cannot
 *      accept type-0 value-only transactions.
 * @notice Deployed by QuaiVaultFactory via CREATE2 for deterministic addresses.
 */
contract QuaiVaultProxy is ERC1967Proxy {
    /// @notice Emitted when QUAI is received via the proxy's own receive().
    /// @dev Signature matches QuaiVault.Received(address,uint256) exactly,
    ///      so indexers see the same event topic regardless of which receive() fires.
    event Received(address indexed sender, uint256 value);

    /**
     * @notice Stores implementation in ERC1967 slot, then DELEGATECALLs `data`
     *         (which encodes QuaiVault.initialize(owners, threshold, minExecutionDelay))
     * @param implementation Address of the QuaiVault implementation contract
     * @param data ABI-encoded initialize() call
     */
    constructor(
        address implementation,
        bytes memory data
    ) ERC1967Proxy(implementation, data) {}

    /**
     * @notice Returns the current implementation address stored in the ERC1967 slot
     * @return Implementation contract address
     */
    function getImplementation() external view returns (address) {
        return _implementation();
    }

    /**
     * @notice Accept plain native QUAI transfers without delegatecall.
     * @dev On Quai Network, quais.js skips access list creation for type-0 transactions
     *      with empty calldata. ERC-1167 clones need the implementation address in the
     *      access list for DELEGATECALL to work, so they fail for plain value sends.
     *      This receive() runs entirely in the proxy's own context — no DELEGATECALL,
     *      no access list needed. OZ Proxy only defines fallback(), not receive(),
     *      so no override keyword is needed. Solidity dispatches msg.data.length==0
     *      to receive() before fallback().
     */
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
