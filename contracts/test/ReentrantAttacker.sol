// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title ReentrantAttacker - Attempts reentrancy on QuaiVault.executeTransaction
 * @dev On receiving ETH, calls back into executeTransaction with the stored txHash.
 *      This should always fail due to OpenZeppelin's nonReentrant guard.
 */
contract ReentrantAttacker {
    address public target;
    bytes32 public attackTxHash;
    bool public attackAttempted;
    bool public attackSucceeded;

    constructor(address _target) {
        target = _target;
    }

    function setAttackHash(bytes32 _txHash) external {
        attackTxHash = _txHash;
    }

    receive() external payable {
        if (!attackAttempted) {
            attackAttempted = true;
            // Attempt reentrant call into executeTransaction
            (bool success, ) = target.call(
                abi.encodeWithSignature("executeTransaction(bytes32)", attackTxHash)
            );
            attackSucceeded = success;
        }
    }
}
