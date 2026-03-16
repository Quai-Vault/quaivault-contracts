// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/Enum.sol";

/**
 * @title MockModule - Test helper for Zodiac interface testing
 * @dev Simulates a module calling execTransactionFromModule
 */
contract MockModule {
    /// @notice The target wallet/avatar to execute transactions on
    address public target;

    /// @notice Event emitted when exec is called
    event ExecCalled(address to, uint256 value, bytes data, Enum.Operation operation);

    constructor(address _target) {
        target = _target;
    }

    /**
     * @notice Set the target wallet
     * @param _target New target address
     */
    function setTarget(address _target) external {
        target = _target;
    }

    /**
     * @notice Execute a transaction on the target wallet (4-param version)
     * @param to Destination address
     * @param value Amount to send
     * @param data Transaction calldata
     * @param operation Call type (0=Call, 1=DelegateCall)
     * @return success Whether the execution succeeded
     */
    function exec(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success) {
        emit ExecCalled(to, value, data, operation);

        // Call the 4-param execTransactionFromModule on the target
        (success, ) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes,uint8)",
                to,
                value,
                data,
                uint8(operation)
            )
        );
    }

    /**
     * @notice Execute a transaction on the target wallet, bubbling up any revert
     * @dev Unlike exec(), this reverts if the inner call reverts (for testing revert reasons)
     */
    function execStrict(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success) {
        emit ExecCalled(to, value, data, operation);

        (bool callSuccess, bytes memory returnData) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes,uint8)",
                to,
                value,
                data,
                uint8(operation)
            )
        );

        if (!callSuccess) {
            assembly { revert(add(returnData, 32), mload(returnData)) }
        }
        success = true;
    }

    /**
     * @notice Execute a transaction on the target wallet (3-param legacy version)
     * @param to Destination address
     * @param value Amount to send
     * @param data Transaction calldata
     * @return success Whether the execution succeeded
     */
    function execLegacy(
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bool success) {
        emit ExecCalled(to, value, data, Enum.Operation.Call);

        // Call the 3-param execTransactionFromModule on the target
        (success, ) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes)",
                to,
                value,
                data
            )
        );
    }

    /**
     * @notice Execute a transaction and return data
     * @param to Destination address
     * @param value Amount to send
     * @param data Transaction calldata
     * @param operation Call type (0=Call, 1=DelegateCall)
     * @return success Whether the execution succeeded
     * @return returnData Data returned from the call
     */
    function execReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success, bytes memory returnData) {
        emit ExecCalled(to, value, data, operation);

        // Call execTransactionFromModuleReturnData on the target
        (bool callSuccess, bytes memory result) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModuleReturnData(address,uint256,bytes,uint8)",
                to,
                value,
                data,
                uint8(operation)
            )
        );

        if (callSuccess && result.length >= 64) {
            // Decode the return value (bool success, bytes memory returnData)
            (success, returnData) = abi.decode(result, (bool, bytes));
        } else {
            success = false;
            returnData = result;
        }
    }

    /**
     * @notice Try to call enableModule (should be blocked by security check)
     * @param module Module address to try to enable
     * @return success Should always be false due to security check
     */
    function tryEnableModule(address module) external returns (bool success) {
        bytes memory data = abi.encodeWithSignature("enableModule(address)", module);

        (success, ) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes)",
                target,
                0,
                data
            )
        );
    }

    /**
     * @notice Try to call disableModule (should be blocked by security check)
     * @param prevModule Previous module in linked list
     * @param module Module address to try to disable
     * @return success Should always be false due to security check
     */
    function tryDisableModule(address prevModule, address module) external returns (bool success) {
        bytes memory data = abi.encodeWithSignature(
            "disableModule(address,address)",
            prevModule,
            module
        );

        (success, ) = target.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes)",
                target,
                0,
                data
            )
        );
    }

    /// @notice Allow receiving ETH
    receive() external payable {}
}
