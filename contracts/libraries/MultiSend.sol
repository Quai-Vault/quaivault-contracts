// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.22; // locked to match production compiler version

/**
 * @title MultiSend - Allows batched transactions via delegatecall
 * @author Gnosis Team (Richard Meissner - richard@gnosis.io)
 * @notice Source: https://github.com/safe-global/safe-contracts
 * @dev Adapted for Quai-Vault Zodiac integration
 */
contract MultiSend {
    address private immutable multisendSingleton;

    constructor() {
        multisendSingleton = address(this);
    }

    /**
     * @dev Prevents direct calls to multiSend (must be called via delegatecall)
     *      to prevent unintended storage modifications
     */
    modifier onlyDelegateCall() {
        require(
            address(this) != multisendSingleton,
            "MultiSend should only be called via delegatecall"
        );
        _;
    }

    /**
     * @notice Execute multiple transactions in sequence
     * @dev Each transaction is encoded as:
     *      - operation (uint8): 0 for call, 1 for delegatecall
     *      - to (address): target address
     *      - value (uint256): ETH value
     *      - dataLength (uint256): length of data
     *      - data (bytes): calldata
     * @param transactions Encoded transactions (packed bytes)
     */
    function multiSend(bytes memory transactions) public payable onlyDelegateCall {
        assembly {
            let length := mload(transactions)
            let i := 0x20
            for {
            } lt(i, length) {
            } {
                // Load operation (first byte)
                let operation := shr(0xf8, mload(add(transactions, i)))
                // Load to address (next 20 bytes)
                let to := shr(0x60, mload(add(transactions, add(i, 0x01))))
                // Load value (next 32 bytes)
                let value := mload(add(transactions, add(i, 0x15)))
                // Load data length (next 32 bytes)
                let dataLength := mload(add(transactions, add(i, 0x35)))
                // Load data pointer
                let data := add(transactions, add(i, 0x55))

                let success := 0
                switch operation
                case 0 {
                    // Call
                    success := call(gas(), to, value, data, dataLength, 0, 0)
                }
                case 1 {
                    // DelegateCall
                    success := delegatecall(gas(), to, data, dataLength, 0, 0)
                }

                if eq(success, 0) {
                    // L-3: Propagate revert data from failed sub-transaction for debuggability
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                // Move to next transaction
                i := add(i, add(0x55, dataLength))
            }
        }
    }
}
