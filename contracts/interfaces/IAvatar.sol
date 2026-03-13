// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.22;

import "../libraries/Enum.sol";

/**
 * @title IAvatar - Zodiac standard interface for modular smart accounts
 * @author Gnosis Team (adapted for Quai-Vault)
 * @notice Standard interface for avatars (smart accounts) that support modular execution
 * @dev See: https://github.com/gnosis/zodiac/blob/master/contracts/interfaces/IAvatar.sol
 *
 * This interface defines the Zodiac IAvatar standard, enabling compatibility with:
 * - Moloch V3 (Baal) DAOs
 * - OpenZeppelin Governor modules
 * - Zodiac Modifiers (Delay, Roles, Scope)
 * - Safe App and DAOhaus UIs
 * - MultiSend batched transactions
 *
 * ## Usage for Module Developers
 *
 * ### Simple Modules (Call only)
 * For modules that only need basic Call operations, use the 3-param convenience function:
 * ```solidity
 * IAvatar(avatar).execTransactionFromModule(to, value, data);
 * ```
 *
 * ### Advanced Modules (DelegateCall, batching, return data)
 * For modules that need DelegateCall (e.g., MultiSend batching):
 * ```solidity
 * IAvatar(avatar).execTransactionFromModule(to, value, data, Enum.Operation.DelegateCall);
 * ```
 *
 * For modules that need to capture return data:
 * ```solidity
 * (bool success, bytes memory returnData) = IAvatar(avatar).execTransactionFromModuleReturnData(
 *     to, value, data, Enum.Operation.Call
 * );
 * ```
 */
interface IAvatar {
    /// @notice Emitted when a module is enabled
    /// @param module Address of the enabled module
    event EnabledModule(address indexed module);

    /// @notice Emitted when a module is disabled
    /// @param module Address of the disabled module
    event DisabledModule(address indexed module);

    /// @notice Emitted when module execution succeeds
    /// @param module Address of the module that executed the transaction
    event ExecutionFromModuleSuccess(address indexed module);

    /// @notice Emitted when module execution fails
    /// @param module Address of the module that attempted execution
    event ExecutionFromModuleFailure(address indexed module);

    /**
     * @notice Enable a module on the avatar
     * @dev Modules are stored in a linked list for enumeration support.
     *      Can only be called by the avatar itself (requires owner approval).
     * @param module Address of the module to enable
     */
    function enableModule(address module) external;

    /**
     * @notice Disable a module on the avatar
     * @dev Requires prevModule for O(1) linked list removal.
     *      Use SENTINEL (0x1) as prevModule for the first module in the list.
     *      Can only be called by the avatar itself (requires owner approval).
     * @param prevModule Address of the module that points to the module to remove
     * @param module Address of the module to disable
     */
    function disableModule(address prevModule, address module) external;

    /**
     * @notice Check if a module is enabled
     * @param module Address to check
     * @return True if the module is enabled
     */
    function isModuleEnabled(address module) external view returns (bool);

    /**
     * @notice Get a paginated list of enabled modules
     * @dev Use SENTINEL (0x1) as start for the first page.
     *      Returns next=SENTINEL when the end of the list is reached.
     * @param start Start of the page (use SENTINEL for first page)
     * @param pageSize Maximum number of modules to return
     * @return array Array of module addresses
     * @return next Address to use as start for the next page (SENTINEL if done)
     */
    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view returns (address[] memory array, address next);

    /**
     * @notice Execute a transaction from an authorized module
     * @dev Supports both Call and DelegateCall operations.
     *      Only callable by enabled modules.
     * @param to Destination address
     * @param value Amount of native token to send (ignored for DelegateCall)
     * @param data Transaction calldata
     * @param operation Operation type: Call (0) or DelegateCall (1)
     * @return success True if the transaction succeeded
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success);

    /**
     * @notice Execute a transaction from an authorized module and return data
     * @dev Same as execTransactionFromModule but also returns the call's return data.
     *      Useful for modules that need to read results from their calls.
     * @param to Destination address
     * @param value Amount of native token to send (ignored for DelegateCall)
     * @param data Transaction calldata
     * @param operation Operation type: Call (0) or DelegateCall (1)
     * @return success True if the transaction succeeded
     * @return returnData Data returned from the call
     */
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success, bytes memory returnData);
}

/**
 * @title ISimpleModuleExecutor - Simplified interface for basic modules
 * @notice Convenience interface for modules that only need Call operations
 * @dev This is NOT a separate standard - it's a subset of IAvatar for documentation.
 *      The QuaiVault implements this via function overloading.
 *
 * ## When to Use
 * Use this interface pattern when your module:
 * - Only needs to make external calls (not DelegateCall)
 * - Doesn't need to capture return data
 * - Wants simpler code without importing Enum.sol
 *
 * ## Example
 * ```solidity
 * contract MySimpleModule {
 *     function execute(address wallet, address recipient, uint256 amount) external {
 *         // No need to import Enum.sol - defaults to Call operation
 *         QuaiVault(wallet).execTransactionFromModule(
 *             recipient,
 *             amount,
 *             ""  // empty data for simple ETH transfer
 *         );
 *     }
 * }
 * ```
 */
interface ISimpleModuleExecutor {
    /**
     * @notice Check if a module is enabled
     * @param module Address to check
     * @return True if the module is enabled
     */
    function isModuleEnabled(address module) external view returns (bool);

    /**
     * @notice Execute a Call transaction from an authorized module
     * @dev This is a convenience function that defaults to Operation.Call.
     *      Equivalent to execTransactionFromModule(to, value, data, Operation.Call).
     * @param to Destination address
     * @param value Amount of native token to send
     * @param data Transaction calldata
     * @return success True if the transaction succeeded
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bool success);
}
