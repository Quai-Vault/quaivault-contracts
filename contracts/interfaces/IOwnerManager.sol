// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.22;

/**
 * @title IOwnerManager - Interface for owner management on modular smart accounts
 * @notice Defines the owner management surface used by modules (e.g., SocialRecoveryModule)
 * @dev Follows the Safe/Candide pattern where modules encode calldata against this interface
 *      and execute it via `execTransactionFromModule`. The avatar calls its own owner management
 *      functions through the module execution channel.
 *
 * This interface is intentionally separate from IAvatar (Zodiac standard), which only covers
 * module management and execution — NOT owner management. This separation follows the same
 * architectural decision made by Gnosis Safe (ISafe = IModuleManager + IOwnerManager).
 */
interface IOwnerManager {
    /**
     * @notice Add a new owner to the smart account
     * @param owner Address of the new owner
     */
    function addOwner(address owner) external;

    /**
     * @notice Remove an owner from the smart account
     * @param owner Address of the owner to remove
     */
    function removeOwner(address owner) external;

    /**
     * @notice Change the required approval threshold
     * @param _threshold New threshold value
     */
    function changeThreshold(uint256 _threshold) external;

    /**
     * @notice Get the list of current owners
     * @return Array of owner addresses
     */
    function getOwners() external view returns (address[] memory);

    /**
     * @notice Check if an address is an owner
     * @param owner Address to check
     * @return True if the address is an owner
     */
    function isOwner(address owner) external view returns (bool);
}
