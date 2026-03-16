// SPDX-License-Identifier: MIT
pragma solidity 0.8.22; // L-1: locked to match production compiler version

import "./QuaiVault.sol";
import "./QuaiVaultProxy.sol";

/**
 * @title QuaiVaultFactory
 * @dev Factory contract for deploying new QuaiVault multisig wallets as ERC1967 constructor proxies
 * @notice Uses CREATE2 for deterministic addresses on Quai Network
 */
contract QuaiVaultFactory {
    // Custom errors (gas efficient)
    error InvalidImplementationAddress();
    error OwnersRequired();
    error TooManyOwners();
    error InvalidOwnerAddress();
    error DuplicateOwner();
    error InvalidThreshold();
    error InvalidWalletAddress();
    error WalletAlreadyRegistered();
    error CallerIsNotAnOwner();
    error InvalidWalletImplementation();
    error ExecutionDelayTooLong();      // L-1: minExecutionDelay exceeds MAX_EXECUTION_DELAY

    /// @notice Maximum allowed minExecutionDelay (30 days) to prevent accidental wallet bricking (L-1)
    uint32 public constant MAX_EXECUTION_DELAY = 30 days;

    /// @notice Address of the QuaiVault implementation contract
    /// @dev Immutable for security - prevents factory from being used to deploy with malicious implementation
    address public immutable implementation;

    /// @notice Expected runtime codehash of QuaiVaultProxy instances (BB-L-1)
    /// @dev Used by registerWallet to verify wallet bytecode via extcodehash (unforgeable EVM opcode).
    ///      All QuaiVaultProxy instances share identical runtime bytecode (no immutables that vary per instance).
    bytes32 public immutable proxyCodeHash;

    /// @notice Array of all deployed wallet addresses
    /// @dev Use getWalletCount() + deployedWallets(index) for paginated access, or event indexing at scale
    address[] public deployedWallets;

    /// @notice Mapping to check if an address is a registered wallet
    mapping(address => bool) public isWallet;

    /// @notice Emitted when a new wallet is created through the factory
    event WalletCreated(
        address indexed wallet,
        address[] owners,
        uint256 threshold,
        address indexed creator,
        bytes32 salt
    );

    /// @notice Emitted when an externally deployed wallet is registered
    event WalletRegistered(
        address indexed wallet,
        address indexed registrar
    );

    constructor(address _implementation) {
        if (_implementation == address(0)) revert InvalidImplementationAddress();
        implementation = _implementation;
        // BB-L-1: Compute expected proxy runtime codehash for registerWallet verification.
        // QuaiVaultProxy has no immutables, so runtime bytecode is identical for all instances.
        proxyCodeHash = keccak256(type(QuaiVaultProxy).runtimeCode);
    }

    /**
     * @notice L-6: Validate owners array before deploying proxy — avoids burning deploy gas
     *         on inputs that initialize() would reject.
     */
    function _validateOwners(address[] calldata owners, uint256 threshold) internal pure {
        if (owners.length == 0) revert OwnersRequired();
        if (owners.length > 20) revert TooManyOwners(); // MUST match QuaiVault.MAX_OWNERS — update both if changed
        if (threshold == 0 || threshold > owners.length) revert InvalidThreshold();
        for (uint256 i = 0; i < owners.length;) {
            if (owners[i] == address(0) || owners[i] == address(1)) revert InvalidOwnerAddress(); // BB-M-2: also reject SENTINEL
            for (uint256 j = i + 1; j < owners.length;) {
                if (owners[i] == owners[j]) revert DuplicateOwner();
                unchecked { j++; }
            }
            unchecked { i++; }
        }
    }

    /**
     * @notice Create a new multisig wallet
     * @param owners Array of owner addresses
     * @param threshold Number of required approvals
     * @param salt Salt for CREATE2 (must be mined for valid shard prefix)
     * @return wallet Address of the created wallet
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt
    ) external returns (address wallet) {
        _validateOwners(owners, threshold);

        // Encode initialize call for the constructor's delegatecall
        bytes memory initData = abi.encodeCall(
            QuaiVault.initialize,
            (owners, threshold, 0, true)
        );

        // Deploy ERC1967 constructor proxy with CREATE2
        bytes32 fullSalt = keccak256(abi.encodePacked(msg.sender, salt));
        wallet = address(new QuaiVaultProxy{salt: fullSalt}(implementation, initData));

        // Register wallet
        deployedWallets.push(wallet);
        isWallet[wallet] = true;

        emit WalletCreated(wallet, owners, threshold, msg.sender, salt);

        return wallet;
    }

    /**
     * @notice Create a new multisig wallet with a minimum execution delay
     * @param owners Array of owner addresses
     * @param threshold Number of required approvals
     * @param salt Salt for CREATE2 (must be mined for valid shard prefix)
     * @param minExecutionDelay Vault-level minimum delay for external calls in seconds (0 = simple quorum)
     * @return wallet Address of the created wallet
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt,
        uint32 minExecutionDelay
    ) external returns (address wallet) {
        _validateOwners(owners, threshold);
        if (minExecutionDelay > MAX_EXECUTION_DELAY) revert ExecutionDelayTooLong(); // L-1

        // Encode initialize call for the constructor's delegatecall
        bytes memory initData = abi.encodeCall(
            QuaiVault.initialize,
            (owners, threshold, minExecutionDelay, true)
        );

        // Deploy ERC1967 constructor proxy with CREATE2
        bytes32 fullSalt = keccak256(abi.encodePacked(msg.sender, salt));
        wallet = address(new QuaiVaultProxy{salt: fullSalt}(implementation, initData));

        // Register wallet
        deployedWallets.push(wallet);
        isWallet[wallet] = true;

        emit WalletCreated(wallet, owners, threshold, msg.sender, salt);

        return wallet;
    }

    /**
     * @notice Create a new multisig wallet with full configuration
     * @param owners Array of owner addresses
     * @param threshold Number of required approvals
     * @param salt Salt for CREATE2 (must be mined for valid shard prefix)
     * @param minExecutionDelay Vault-level minimum delay for external calls in seconds (0 = simple quorum)
     * @param delegatecallDisabled CR-1: When true, modules cannot execute DelegateCall operations.
     *        Set to false for vaults that need DelegateCall modules (e.g., Baal DAO governance via MultiSend).
     * @return wallet Address of the created wallet
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt,
        uint32 minExecutionDelay,
        bool delegatecallDisabled
    ) external returns (address wallet) {
        _validateOwners(owners, threshold);
        if (minExecutionDelay > MAX_EXECUTION_DELAY) revert ExecutionDelayTooLong(); // L-1

        // Encode initialize call for the constructor's delegatecall
        bytes memory initData = abi.encodeCall(
            QuaiVault.initialize,
            (owners, threshold, minExecutionDelay, delegatecallDisabled)
        );

        // Deploy ERC1967 constructor proxy with CREATE2
        bytes32 fullSalt = keccak256(abi.encodePacked(msg.sender, salt));
        wallet = address(new QuaiVaultProxy{salt: fullSalt}(implementation, initData));

        // Register wallet
        deployedWallets.push(wallet);
        isWallet[wallet] = true;

        emit WalletCreated(wallet, owners, threshold, msg.sender, salt);

        return wallet;
    }

    /**
     * @notice Predict the address of a wallet before deployment
     * @param deployer Address that will call createWallet
     * @param salt Salt for CREATE2
     * @param owners Array of owner addresses (needed for constructor arg hash)
     * @param threshold Number of required approvals
     * @param minExecutionDelay Vault-level minimum delay (0 for simple quorum)
     * @param delegatecallDisabled CR-1: Whether DelegateCall is blocked for modules
     * @return Predicted wallet address
     */
    function predictWalletAddress(
        address deployer,
        bytes32 salt,
        address[] calldata owners,
        uint256 threshold,
        uint32 minExecutionDelay,
        bool delegatecallDisabled
    ) external view returns (address) {
        bytes32 fullSalt = keccak256(abi.encodePacked(deployer, salt));
        bytes memory initData = abi.encodeCall(
            QuaiVault.initialize,
            (owners, threshold, minExecutionDelay, delegatecallDisabled)
        );
        bytes32 bytecodeHash = keccak256(abi.encodePacked(
            type(QuaiVaultProxy).creationCode,
            abi.encode(implementation, initData)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            fullSalt,
            bytecodeHash
        )))));
    }

    /**
     * @notice Register an externally deployed wallet (M-3: verifies ERC1967 implementation)
     * @dev Only accepts wallets whose ERC1967 implementation slot points to our implementation
     * @param wallet Address of the wallet to register
     */
    function registerWallet(address wallet) external {
        if (wallet == address(0)) revert InvalidWalletAddress();
        if (isWallet[wallet]) revert WalletAlreadyRegistered();

        // BB-L-1: Verify wallet bytecode matches QuaiVaultProxy via extcodehash (unforgeable).
        // Unlike getImplementation() which is a function call the target controls, extcodehash
        // is an EVM opcode that reads the actual deployed bytecode — cannot be spoofed.
        bytes32 codeHash;
        assembly { codeHash := extcodehash(wallet) }
        if (codeHash != proxyCodeHash) revert InvalidWalletImplementation();

        // M-3: Also verify the ERC1967 implementation slot points to our implementation.
        // The bytecode check above proves it's a real QuaiVaultProxy; this check confirms
        // it's pointing to the correct QuaiVault implementation (not a different factory's).
        try QuaiVaultProxy(payable(wallet)).getImplementation() returns (address impl) {
            if (impl != implementation) revert InvalidWalletImplementation();
        } catch {
            revert InvalidWalletImplementation();
        }

        QuaiVault multisig = QuaiVault(payable(wallet));

        // Verify caller is an owner of the wallet
        if (!multisig.isOwner(msg.sender)) revert CallerIsNotAnOwner();

        // Register wallet
        deployedWallets.push(wallet);
        isWallet[wallet] = true;

        emit WalletRegistered(wallet, msg.sender);
    }

    // M-1: Removed getWallets() — unbounded return at scale
    // M-2: Removed getWalletsByCreator() — O(n^2) with cross-contract calls
    // Use getWalletCount() + deployedWallets(index) or WalletCreated event indexing

    /**
     * @notice Get total number of deployed wallets
     * @return Count of wallets
     */
    function getWalletCount() external view returns (uint256) {
        return deployedWallets.length;
    }
}
