// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.22; // locked to match production compiler version

/**
 * @title MultiSendCallOnly - Batched transactions restricted to Call operations only
 * @author Gnosis Team (Richard Meissner - richard@gnosis.io)
 * @notice Source: https://github.com/safe-global/safe-contracts
 * @dev Adapted for Quai-Vault. Unlike MultiSend, this variant rejects any transaction
 *      with operation=1 (DelegateCall), closing the nested DelegateCall bypass vector
 *      where a whitelisted MultiSend could be used to DelegateCall arbitrary targets
 *      within a batch without hitting the vault's DelegateCall whitelist check.
 *
 *      Recommended as the default DelegateCall whitelist target for most vaults.
 *      Only use regular MultiSend if nested DelegateCall is explicitly required.
 */
contract MultiSendCallOnly {
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
     * @notice Execute multiple Call transactions in sequence (no DelegateCall allowed)
     * @dev Each transaction is encoded as:
     *      - operation (uint8): MUST be 0 (Call). Reverts if 1 (DelegateCall).
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

                // Reject DelegateCall (operation != 0)
                if operation {
                    // revert("DelegateCall not allowed")
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 0x20)
                    mstore(0x24, 24)
                    mstore(0x44, "DelegateCall not allowed")
                    revert(0, 0x64)
                }

                let success := call(gas(), to, value, data, dataLength, 0, 0)

                if eq(success, 0) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                // Move to next transaction
                i := add(i, add(0x55, dataLength))
            }
        }
    }
}
