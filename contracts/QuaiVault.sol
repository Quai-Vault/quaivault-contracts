// SPDX-License-Identifier: MIT
pragma solidity 0.8.22; // I-5: locked to specific version for reproducible builds

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "./libraries/Enum.sol";

/**
 * @title QuaiVault
 * @dev Core multisig wallet implementation used behind ERC1967 constructor proxies
 * @notice This is the implementation contract used by all proxy instances
 * @custom:security-contact security@quaivault.org
 */
contract QuaiVault is
    Initializable,
    ReentrancyGuardUpgradeable,
    ERC721HolderUpgradeable,
    ERC1155HolderUpgradeable,
    IERC1271
{
    // Custom errors (gas efficient)
    error NotAnOwner();
    error OnlySelf();
    error NotAnAuthorizedModule();
    error TransactionDoesNotExist();
    error TransactionAlreadyExecuted();
    error TransactionAlreadyCancelled();
    error OwnersRequired();
    error TooManyOwners();
    error InvalidThreshold();
    error InvalidOwnerAddress();
    error DuplicateOwner();
    error InvalidDestinationAddress();
    error TransactionAlreadyExists();
    error AlreadyApproved();
    error NotEnoughApprovals();
    error NotApproved();
    error NotProposer();
    error CannotCancelApprovedTransaction();
    error AlreadyAnOwner();
    error MaxOwnersReached();
    error CannotRemoveOwnerWouldFallBelowThreshold();
    error ModuleAlreadyEnabled();
    error ModuleNotEnabled();
    error InvalidModule(address module);
    error InvalidPrevModule(address prevModule);
    error TransactionIsExpired();
    error TimelockNotElapsed(uint256 executableAfter);
    error ExpirationTooSoon(uint256 minimumExpiration);
    error TransactionNotExpired();
    error MaxModulesReached();
    error UnrecognizedSelfCall(bytes4 selector);
    error CalldataTooShort();
    error MessageNotSigned();
    error SelfCallCannotHaveValue();

    /// @notice Maximum number of owners allowed (prevents DoS from gas-intensive loops)
    uint256 public constant MAX_OWNERS = 20;

    /// @notice Maximum number of modules allowed
    uint256 public constant MAX_MODULES = 50;

    /// @notice Sentinel address used as head of module linked list (Zodiac IAvatar standard)
    address internal constant SENTINEL_MODULES = address(0x1);

    /// @dev EIP-712 domain separator typehash (I-2: includes name and version for standard compliance)
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev EIP-712 domain name (I-2)
    string private constant DOMAIN_NAME = "QuaiVault";

    /// @dev EIP-712 domain version (I-2)
    string private constant DOMAIN_VERSION = "1";

    /// @dev EIP-712 precomputed domain name hash (avoids runtime keccak256 in domainSeparator)
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("QuaiVault"));

    /// @dev EIP-712 precomputed domain version hash
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    /// @dev EIP-712 message typehash for QuaiVault signed messages
    bytes32 private constant QUAIVAULT_MSG_TYPEHASH =
        keccak256("QuaiVaultMessage(bytes message)");

    /// @notice Structure representing a multisig transaction (L-1: packed for gas efficiency)
    /// @dev 4 storage slots, slot 1 is exactly 32 bytes (zero padding)
    struct Transaction {
        address to;              // 20 bytes \
        uint48  timestamp;       //  6 bytes  } slot 0 (32 bytes)
        uint48  expiration;      //  6 bytes /  C-7: 0 = no expiry
        address proposer;        // 20 bytes \
        bool    executed;        //  1 byte   \
        bool    cancelled;       //  1 byte    } slot 1 (32 bytes exactly)
        uint48  approvedAt;      //  6 bytes  /  set ONCE on first threshold crossing, never cleared
        uint32  executionDelay;  //  4 bytes /   max(minExecutionDelay, requestedDelay), locked at proposal
        uint256 value;           // slot 2
        bytes   data;            // slot 3 (pointer)
    }

    // ==================== State Variables ====================
    // Storage layout: slots 0-9, appended in order

    /// @notice Mapping of address to owner status
    mapping(address => bool) public isOwner;

    /// @notice Array of all owner addresses
    address[] public owners;

    /// @notice Number of approvals required to execute a transaction
    uint256 public threshold;

    /// @notice Transaction nonce for unique hash generation
    uint256 public nonce;

    /// @notice Mapping of transaction hash to transaction data
    mapping(bytes32 => Transaction) public transactions;

    /// @notice H-2: Epoch-based approvals — stores the owner-version at which each owner approved.
    /// @dev An approval is valid iff _approvalEpochs[txHash][owner] == ownerVersions[owner] + 1.
    ///      Removing an owner increments ownerVersions[owner], automatically invalidating all their
    ///      prior approvals without iterating in-flight transactions. If the same address is re-added,
    ///      old approvals are still invalidated (new epoch required). Use hasApproved() to query.
    /// @dev Overflow note: ownerVersions would need to reach type(uint256).max for the sentinel value 0
    ///      to falsely match — requiring 2^256 removals of the same address. Physically impossible.
    mapping(bytes32 => mapping(address => uint256)) internal _approvalEpochs;

    /// @notice H-2: Per-owner version counter incremented on each removal
    /// @dev Starts at 0; approval stored as ownerVersions[owner]+1. Incrementing on removal
    ///      atomically invalidates all prior approvals from that address without touching in-flight
    ///      transaction storage.
    mapping(address => uint256) public ownerVersions;

    /// @notice Linked list of enabled module addresses (Zodiac IAvatar compatible)
    mapping(address => address) internal modules;

    /// @notice Mapping of approved message hashes for EIP-1271 signature validation
    mapping(bytes32 => bool) public signedMessages;

    /// @notice L-3: Distinguishes expired transactions from voluntarily cancelled ones.
    /// @dev Set true by expireTransaction(). Cancelled transactions have cancelled=true but
    ///      expiredTxs[txHash]=false. Expired transactions have both cancelled=true and
    ///      expiredTxs[txHash]=true. Use this mapping for unambiguous struct introspection.
    mapping(bytes32 => bool) public expiredTxs;

    // --- New state variables (appended after expiredTxs) ---

    /// @notice Count of enabled modules for MAX_MODULES enforcement (L-3)
    uint256 public moduleCount;

    /// @notice Vault-level minimum execution delay for external calls in seconds (0 = simple quorum)
    /// @dev Prospective only — changing this does NOT affect in-flight transactions, which
    ///      retain the executionDelay locked in at proposal time.
    uint32 public minExecutionDelay;

    // ==================== Events ====================

    /// @notice I-1: Includes expiration and executionDelay for complete off-chain lifecycle tracking
    event TransactionProposed(
        bytes32 indexed txHash,
        address indexed proposer,
        address indexed to,
        uint256 value,
        bytes data,
        uint48 expiration,
        uint32 executionDelay
    );

    event TransactionApproved(
        bytes32 indexed txHash,
        address indexed approver
    );

    event TransactionExecuted(
        bytes32 indexed txHash,
        address indexed executor
    );

    event ApprovalRevoked(
        bytes32 indexed txHash,
        address indexed owner
    );

    event TransactionCancelled(
        bytes32 indexed txHash,
        address indexed canceller
    );

    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);
    event EnabledModule(address indexed module);
    event DisabledModule(address indexed module);
    event ExecutionFromModuleSuccess(address indexed module);
    event ExecutionFromModuleFailure(address indexed module);
    event Received(address indexed sender, uint256 amount);
    event MessageSigned(bytes32 indexed msgHash, bytes data);

    /// @notice Emitted when a signed message is revoked (M-NEW-3)
    event MessageUnsigned(bytes32 indexed msgHash, bytes data);

    /// @notice Emitted once when threshold is first crossed; executableAfter is fixed and final
    event ThresholdReached(bytes32 indexed txHash, uint48 approvedAt, uint256 executableAfter);

    /// @notice Emitted on external call failure (Option B — never reverts on external failures)
    event TransactionFailed(bytes32 indexed txHash, address indexed executor, bytes returnData);

    /// @notice Emitted when vault-level minimum delay changes
    event MinExecutionDelayChanged(uint32 oldDelay, uint32 newDelay);

    /// @notice Emitted when an expired tx is formally closed via expireTransaction
    event TransactionExpired(bytes32 indexed txHash);

    // ==================== Modifiers ====================

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotAnOwner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    modifier onlyModule() {
        if (!isModuleEnabled(msg.sender)) revert NotAnAuthorizedModule();
        _;
    }

    modifier txExists(bytes32 txHash) {
        if (transactions[txHash].to == address(0)) revert TransactionDoesNotExist();
        _;
    }

    modifier notExecuted(bytes32 txHash) {
        if (transactions[txHash].executed) revert TransactionAlreadyExecuted();
        _;
    }

    modifier notCancelled(bytes32 txHash) {
        if (transactions[txHash].cancelled) revert TransactionAlreadyCancelled();
        _;
    }

    // ==================== Constructor ====================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ==================== Initialization ====================

    /**
     * @notice Initialize the multisig wallet
     * @param _owners Array of owner addresses
     * @param _threshold Number of required approvals
     * @param _minExecutionDelay Vault-level minimum timelock for external calls in seconds (0 = simple quorum)
     */
    function initialize(
        address[] memory _owners,
        uint256 _threshold,
        uint32 _minExecutionDelay
    ) external initializer {
        if (_owners.length == 0) revert OwnersRequired();
        if (_owners.length > MAX_OWNERS) revert TooManyOwners();
        if (_threshold == 0 || _threshold > _owners.length) revert InvalidThreshold();

        __ReentrancyGuard_init();
        __ERC721Holder_init();
        __ERC1155Holder_init();

        for (uint256 i = 0; i < _owners.length;) {
            address owner = _owners[i];

            if (owner == address(0) || owner == address(this)) revert InvalidOwnerAddress();
            if (isOwner[owner]) revert DuplicateOwner();

            isOwner[owner] = true;
            owners.push(owner);
            unchecked { i++; }
        }

        threshold = _threshold;
        minExecutionDelay = _minExecutionDelay;
        // M-4: nonce defaults to 0, no explicit assignment needed

        // Initialize module linked list (empty list: sentinel points to itself)
        modules[SENTINEL_MODULES] = SENTINEL_MODULES;
    }

    // ==================== Transaction Lifecycle ====================

    /**
     * @notice Propose a new transaction with expiration and per-transaction delay
     * @param to Destination address
     * @param value Amount of Quai to send
     * @param data Transaction data
     * @param expiration Unix timestamp after which tx cannot be executed (0 = no expiry)
     * @param requestedDelay Additional delay in seconds beyond vault minimum (0 = use vault floor)
     * @return txHash The transaction hash
     */
    function proposeTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint48 expiration,
        uint32 requestedDelay
    ) external onlyOwner returns (bytes32) {
        return _proposeTransaction(to, value, data, expiration, requestedDelay);
    }

    /**
     * @notice Propose a new transaction with expiration (C-7)
     * @param to Destination address
     * @param value Amount of Quai to send
     * @param data Transaction data
     * @param expiration Unix timestamp after which tx cannot be executed (0 = no expiry)
     * @return txHash The transaction hash
     */
    function proposeTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint48 expiration
    ) external onlyOwner returns (bytes32) {
        return _proposeTransaction(to, value, data, expiration, 0);
    }

    /**
     * @notice Propose a new transaction (backward-compatible overload, no expiry, no delay)
     * @param to Destination address
     * @param value Amount of Quai to send
     * @param data Transaction data
     * @return txHash The transaction hash
     */
    function proposeTransaction(
        address to,
        uint256 value,
        bytes calldata data
    ) external onlyOwner returns (bytes32) {
        return _proposeTransaction(to, value, data, 0, 0);
    }

    /**
     * @notice Internal proposal logic
     * @dev Self-calls always get executionDelay=0 regardless of vault floor or requestedDelay.
     *      ExpirationTooSoon validates that expiration allows at least one execution opportunity.
     *      L-1: Rejects self-calls with value > 0 at proposal time (would always revert at execution).
     */
    function _proposeTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint48 expiration,
        uint32 requestedDelay
    ) internal returns (bytes32) {
        if (to == address(0)) revert InvalidDestinationAddress();

        // L-1: Reject self-calls carrying value at proposal time.
        // _executeTransaction would always revert with SelfCallCannotHaveValue; catching this
        // early prevents proposals that can never succeed from wasting approver gas.
        if (to == address(this) && value > 0) revert SelfCallCannotHaveValue();

        // Self-calls always execute immediately — storing a non-zero delay would be misleading
        // since _executeTransaction bypasses the timelock check for self-calls.
        uint32 effectiveDelay = (to == address(this))
            ? 0
            : (requestedDelay > minExecutionDelay ? requestedDelay : minExecutionDelay);

        // Validate expiration is far enough in the future to allow at least one execution attempt
        // after the timelock elapses. Uses current block.timestamp as proxy for approval time.
        if (expiration != 0) {
            uint256 minimumExpiration;
            unchecked { minimumExpiration = block.timestamp + effectiveDelay; } // uint32 delay can't overflow uint256
            if (expiration <= minimumExpiration) revert ExpirationTooSoon(minimumExpiration);
        }

        bytes32 txHash = getTransactionHash(to, value, data, nonce);

        // M-5: Nonce increment makes hash collisions impossible, simple existence check
        if (transactions[txHash].to != address(0)) revert TransactionAlreadyExists();

        transactions[txHash] = Transaction({
            to: to,
            timestamp: uint48(block.timestamp),
            expiration: expiration,
            proposer: msg.sender,
            executed: false,
            cancelled: false,
            approvedAt: 0,
            executionDelay: effectiveDelay,
            value: value,
            data: data
        });

        unchecked { nonce++; } // uint256 can't overflow in practice

        // I-1: Include expiration and executionDelay for complete off-chain lifecycle tracking
        emit TransactionProposed(txHash, msg.sender, to, value, data, expiration, effectiveDelay);

        return txHash;
    }

    /**
     * @notice Approve a pending transaction
     * @param txHash Transaction hash to approve
     */
    function approveTransaction(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
    {
        // H-2: Epoch-based check prevents ghost approval resurrection after owner remove/re-add
        if (_approvalValid(txHash, msg.sender)) revert AlreadyApproved();

        _setApproval(txHash, msg.sender);

        emit TransactionApproved(txHash, msg.sender);

        // Detect first threshold crossing — set approvedAt permanently (never cleared by revocation).
        // This starts the timelock clock. Once set, approvedAt is the permanent record that quorum
        // was reached, regardless of subsequent revocations.
        Transaction storage transaction = transactions[txHash];
        if (transaction.approvedAt == 0 && _countValidApprovals(txHash) >= threshold) {
            transaction.approvedAt = uint48(block.timestamp);
            uint256 executableAfter;
            unchecked { executableAfter = uint256(transaction.approvedAt) + transaction.executionDelay; } // uint48 + uint32 can't overflow uint256
            emit ThresholdReached(txHash, transaction.approvedAt, executableAfter);
        }
    }

    /**
     * @notice Approve and execute a transaction in one call if threshold is met and timelock elapsed
     * @param txHash Transaction hash to approve and potentially execute
     * @return executed Whether the transaction was executed (false = not enough approvals OR timelocked)
     * @dev Returns false (not revert) when timelocked but approved — ThresholdReached event
     *      distinguishes "approved but waiting" from "not enough approvals" for off-chain callers.
     *      TransactionApproved is emitted only when a new approval is recorded (not if already approved).
     */
    function approveAndExecute(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
        nonReentrant
        returns (bool executed)
    {
        // H-2: epoch-based approval — set only if not already approved at current version.
        // M-2: Emit TransactionApproved only when the approval is actually added.
        //      The TransactionExecuted event identifies who triggered the execution.
        //      Unconditional emission caused indexers to over-count approvals.
        if (!_approvalValid(txHash, msg.sender)) {
            _setApproval(txHash, msg.sender);
            emit TransactionApproved(txHash, msg.sender);
        }

        Transaction storage transaction = transactions[txHash];
        uint256 validCount = _countValidApprovals(txHash); // single call, result cached

        // Detect first threshold crossing
        if (transaction.approvedAt == 0 && validCount >= threshold) {
            transaction.approvedAt = uint48(block.timestamp);
            uint256 executableAfter;
            unchecked { executableAfter = uint256(transaction.approvedAt) + transaction.executionDelay; } // uint48 + uint32 can't overflow uint256
            emit ThresholdReached(txHash, transaction.approvedAt, executableAfter);
        }

        if (validCount < threshold) return false;

        // For timelocked external calls: return false if delay has not elapsed yet
        bool isSelfCall = transaction.to == address(this);
        if (!isSelfCall && transaction.executionDelay > 0) {
            unchecked {
                if (block.timestamp < uint256(transaction.approvedAt) + transaction.executionDelay)
                    return false;
            }
        }

        _executeTransaction(txHash, transaction);
        return true;
    }

    /**
     * @notice Execute a transaction after threshold is met
     * @param txHash Transaction hash to execute
     * @dev C-6 Lazy clock: if a timelocked external tx reached threshold without going through
     *      approveTransaction (e.g., threshold was lowered mid-flight), the first call sets
     *      approvedAt and returns — it does NOT revert, because EVM reverts roll back all state
     *      changes, which would undo the approvedAt assignment. Caller must call again after delay.
     */
    function executeTransaction(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
        nonReentrant
    {
        Transaction storage transaction = transactions[txHash];

        // C-3: Use _countValidApprovals instead of cached numApprovals
        if (_countValidApprovals(txHash) < threshold) revert NotEnoughApprovals();

        bool isSelfCall = transaction.to == address(this);

        // C-6 Lazy clock start: threshold was met via a path that didn't set approvedAt
        // (e.g., threshold was lowered after owners had already approved). We cannot revert
        // here — a revert would roll back the approvedAt assignment and the clock would
        // never start. Instead, commit the clock start and return; caller tries again after delay.
        if (!isSelfCall && transaction.executionDelay > 0 && transaction.approvedAt == 0) {
            transaction.approvedAt = uint48(block.timestamp);
            uint256 executableAfter;
            unchecked { executableAfter = uint256(transaction.approvedAt) + transaction.executionDelay; } // uint48 + uint32 can't overflow uint256
            emit ThresholdReached(txHash, transaction.approvedAt, executableAfter);
            return;
        }

        _executeTransaction(txHash, transaction);
    }

    /**
     * @notice Revoke approval for a pending transaction
     * @param txHash Transaction hash
     * @dev Does NOT clear approvedAt — once the timelock clock starts it never resets.
     *      Revocation can prevent execution (by dropping below threshold) but cannot
     *      re-open the proposer's cancelTransaction path once approvedAt is set.
     */
    function revokeApproval(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
    {
        // H-2: Epoch-based approval check
        if (!_approvalValid(txHash, msg.sender)) revert NotApproved();

        _clearApproval(txHash, msg.sender);

        emit ApprovalRevoked(txHash, msg.sender);
    }

    /**
     * @notice Cancel a pending transaction (C-2: only proposer, only before threshold ever crossed)
     * @dev Proposer can cancel their own proposal only when approvedAt == 0 (quorum never reached).
     *      Once approvedAt is set it is permanent — even if approvers subsequently revoke,
     *      the proposer cannot cancel. This closes the revoke+cancel clock-gaming attack.
     *      Post-threshold cancellation requires cancelByConsensus (onlySelf, full consensus).
     * @param txHash Transaction hash to cancel
     */
    function cancelTransaction(bytes32 txHash)
        external
        onlyOwner
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
    {
        Transaction storage transaction = transactions[txHash];

        // C-2: Only proposer can cancel
        if (transaction.proposer != msg.sender) revert NotProposer();

        // C-2 (updated): approvedAt is set once and never cleared — permanent record quorum was reached.
        // Blocks cancellation even if current valid approvals have since dropped below threshold.
        if (transaction.approvedAt != 0) revert CannotCancelApprovedTransaction();

        _cancelTransaction(txHash);
    }

    // ==================== Internal Transaction Helpers ====================

    /**
     * @notice Shared execution logic for executeTransaction and approveAndExecute
     * @dev C-7: checks expiry. C-6: enforces timelock for external calls only.
     *      Self-calls always execute immediately and revert on failure (partial state is unsafe).
     *      External calls use Option B: never revert, emit TransactionFailed on failure.
     */
    function _executeTransaction(bytes32 txHash, Transaction storage transaction) internal {
        // C-7: Check expiry (error renamed to avoid ABI collision with TransactionExpired event)
        if (transaction.expiration != 0 && block.timestamp > transaction.expiration)
            revert TransactionIsExpired();

        bool isSelfCall = transaction.to == address(this);

        // C-6: Enforce timelock for external calls only (self-calls always execute immediately).
        // approvedAt is guaranteed non-zero at this point: set either via approveTransaction,
        // approveAndExecute, or the lazy clock path in executeTransaction (which returns before
        // reaching here if the delay hasn't elapsed).
        if (!isSelfCall && transaction.executionDelay > 0) {
            uint256 executableAfter;
            unchecked { executableAfter = uint256(transaction.approvedAt) + transaction.executionDelay; } // uint48 + uint32 can't overflow uint256
            if (block.timestamp < executableAfter)
                revert TimelockNotElapsed(executableAfter);
        }

        transaction.executed = true;

        if (isSelfCall) {
            // L-NEW-1: Self-calls should never carry value (also caught at proposal time by L-1)
            if (transaction.value > 0) revert SelfCallCannotHaveValue();
            _executeSelfCall(transaction.to, transaction.value, transaction.data);
            emit TransactionExecuted(txHash, msg.sender);
            // Note: _executeSelfCall reverts on failure → transaction.executed rolls back (safe)
        } else {
            // Option B: never revert on external call failure — emit TransactionFailed instead.
            // transaction.executed = true is permanent even on failure (terminal EXECUTED state).
            (bool success, bytes memory returnData) =
                transaction.to.call{value: transaction.value}(transaction.data);
            if (success) {
                emit TransactionExecuted(txHash, msg.sender);
            } else {
                emit TransactionFailed(txHash, msg.sender, returnData);
            }
        }
    }

    // ==================== H-2: Epoch-Based Approval Helpers ====================

    /**
     * @notice Check if an owner has a valid (current-epoch) approval for a transaction
     * @dev An approval is valid iff its stored epoch equals ownerVersions[owner] + 1.
     *      Removing an owner increments ownerVersions, atomically invalidating all prior approvals
     *      from that address without touching in-flight transaction storage.
     */
    function _approvalValid(bytes32 txHash, address owner) internal view returns (bool) {
        unchecked {
            return _approvalEpochs[txHash][owner] == ownerVersions[owner] + 1;
        }
    }

    /**
     * @notice Record an approval at the current owner version
     */
    function _setApproval(bytes32 txHash, address owner) internal {
        unchecked {
            _approvalEpochs[txHash][owner] = ownerVersions[owner] + 1;
        }
    }

    /**
     * @notice Clear a single owner's approval (revocation path)
     * @dev Setting to 0 is always invalid since ownerVersions[owner]+1 >= 1
     */
    function _clearApproval(bytes32 txHash, address owner) internal {
        _approvalEpochs[txHash][owner] = 0;
    }

    /**
     * @notice C-3: Count valid approvals from current owners only
     * @dev Iterates owners[] to exclude approvals from removed owners (ghost approvals).
     *      H-2: Epoch check also prevents ghost approval resurrection after remove+re-add.
     */
    function _countValidApprovals(bytes32 txHash) internal view returns (uint256 count) {
        uint256 len = owners.length;
        for (uint256 i = 0; i < len;) {
            if (_approvalValid(txHash, owners[i])) count++;
            unchecked { i++; }
        }
    }

    /**
     * @notice QV-L2: Clear approval state for all current owners
     * @dev Prevents ghost approvals on owner address reuse after cancel/expiry.
     *      Shared between _cancelTransaction and expireTransaction.
     *      Sets epoch to 0, which is never a valid approval epoch (ownerVersions+1 >= 1).
     */
    function _clearApprovals(bytes32 txHash) internal {
        uint256 len = owners.length;
        for (uint256 i = 0; i < len;) {
            _approvalEpochs[txHash][owners[i]] = 0;
            unchecked { i++; }
        }
    }

    /**
     * @notice Shared internal cancel logic — sets cancelled flag, clears approvals, emits event
     */
    function _cancelTransaction(bytes32 txHash) internal {
        transactions[txHash].cancelled = true;
        _clearApprovals(txHash);
        emit TransactionCancelled(txHash, msg.sender);
    }

    // ==================== Owner Management ====================

    function _addOwner(address owner) internal {
        if (owner == address(0) || owner == address(this)) revert InvalidOwnerAddress();
        if (isOwner[owner]) revert AlreadyAnOwner();
        if (owners.length >= MAX_OWNERS) revert MaxOwnersReached();

        isOwner[owner] = true;
        owners.push(owner);

        emit OwnerAdded(owner);
    }

    function addOwner(address owner) external onlySelf {
        _addOwner(owner);
    }

    /**
     * @dev L-7: Uses swap-and-pop for O(1) removal. The owners[] array does NOT maintain
     *      insertion order — removing an owner may change the array index of the last owner.
     *      Off-chain code must not rely on stable owner indices; use isOwner[] for membership checks.
     */
    function _removeOwner(address owner) internal {
        if (!isOwner[owner]) revert NotAnOwner();
        uint256 len = owners.length;
        unchecked {
            if (len - 1 < threshold) revert CannotRemoveOwnerWouldFallBelowThreshold(); // len >= 1 (owner exists)
        }

        isOwner[owner] = false;

        // H-2: Increment owner version to atomically invalidate all in-flight approvals from
        // this address. O(1) — no loop over active transactions needed.
        unchecked { ownerVersions[owner]++; } // uint256 can't overflow in practice

        for (uint256 i = 0; i < len;) {
            if (owners[i] == owner) {
                unchecked { owners[i] = owners[len - 1]; }
                owners.pop();
                break;
            }
            unchecked { i++; }
        }

        emit OwnerRemoved(owner);
    }

    function removeOwner(address owner) external onlySelf {
        _removeOwner(owner);
    }

    function _changeThreshold(uint256 _threshold) internal {
        if (_threshold == 0 || _threshold > owners.length) revert InvalidThreshold();

        threshold = _threshold;

        emit ThresholdChanged(_threshold);
    }

    function changeThreshold(uint256 _threshold) external onlySelf {
        _changeThreshold(_threshold);
    }

    // ==================== Post-Threshold Cancellation ====================

    /**
     * @notice Cancel any pending transaction via multisig consensus (self-call)
     * @dev Requires threshold approvals on the cancel proposal itself — equivalent authority
     *      to executing the original transaction. Self-calls bypass the timelock, so cancellation
     *      is always faster than a timelocked external call (critical for emergency response).
     *      Works on both pre-threshold and post-threshold transactions; the access control is the
     *      onlySelf requirement (full quorum), not the target transaction's approval state.
     *      I-1: Previously named cancelApprovedTransaction — renamed for accuracy (works on any
     *      pending tx, not only approved ones).
     * @param txHash Transaction hash to cancel
     */
    function cancelByConsensus(bytes32 txHash) external onlySelf {
        _cancelByConsensus(txHash);
    }

    /**
     * @dev Inline checks for consistency with _addOwner/_removeOwner patterns.
     *      Not using modifiers on internal functions avoids double-checking when dispatched
     *      through _executeSelfCall.
     */
    function _cancelByConsensus(bytes32 txHash) internal {
        Transaction storage transaction = transactions[txHash];
        if (transaction.to == address(0)) revert TransactionDoesNotExist();
        if (transaction.executed)          revert TransactionAlreadyExecuted();
        if (transaction.cancelled)         revert TransactionAlreadyCancelled();
        _cancelTransaction(txHash);
    }

    // ==================== Execution Delay Management ====================

    /**
     * @notice Update vault-level minimum execution delay for external calls
     * @dev Prospective only — does NOT affect in-flight transactions whose executionDelay
     *      was locked in at proposal time. Requires multisig self-call consensus (`onlySelf`).
     *      Modules with `execTransactionFromModule` access can call this; only enable trusted modules.
     * @param delay New minimum delay in seconds (0 = simple quorum, no timelock)
     */
    function setMinExecutionDelay(uint32 delay) external onlySelf {
        _setMinExecutionDelay(delay);
    }

    function _setMinExecutionDelay(uint32 delay) internal {
        uint32 old = minExecutionDelay;
        minExecutionDelay = delay;
        emit MinExecutionDelayChanged(old, delay);
    }

    // ==================== Expired Transaction Cleanup ====================

    /**
     * @notice Formally close an expired transaction and free approval storage
     * @dev Permissionless — expiration is an immutable on-chain fact; anyone can trigger cleanup.
     *      Not a griefing vector: can only be called after block.timestamp > expiration, at which
     *      point _executeTransaction would also revert with TransactionIsExpired. The tx is already
     *      dead; expireTransaction formalizes it and reclaims the approval storage.
     *      L-3: Sets expiredTxs[txHash]=true so callers can distinguish expired from cancelled
     *      without relying solely on event logs.
     * @param txHash Transaction hash to expire
     */
    function expireTransaction(bytes32 txHash)
        external
        txExists(txHash)
        notExecuted(txHash)
        notCancelled(txHash)
    {
        Transaction storage transaction = transactions[txHash];
        if (transaction.expiration == 0 || block.timestamp <= transaction.expiration)
            revert TransactionNotExpired();
        transaction.cancelled = true; // reuse cancelled as terminal flag (prevents re-execution)
        expiredTxs[txHash] = true;    // L-3: unambiguous expired state for struct introspection
        _clearApprovals(txHash);      // QV-L2 fix
        emit TransactionExpired(txHash); // distinct from TransactionCancelled for indexers
    }

    // ==================== Self-Call Dispatch ====================

    /**
     * @notice Internal dispatch for self-calls (H-3: reverts on unrecognized selectors)
     * @dev All onlySelf functions are dispatched internally via their _internal counterparts
     *      to avoid reentrancy guard issues with external self-calls
     */
    function _executeSelfCall(
        address /* to */,
        uint256 /* value */,
        bytes memory data
    ) internal {
        if (data.length < 4) revert CalldataTooShort();
        bytes4 selector = bytes4(data);

        if (selector == this.addOwner.selector) {
            address newOwner = abi.decode(_stripSelector(data), (address));
            _addOwner(newOwner);
        } else if (selector == this.removeOwner.selector) {
            address ownerToRemove = abi.decode(_stripSelector(data), (address));
            _removeOwner(ownerToRemove);
        } else if (selector == this.changeThreshold.selector) {
            uint256 newThreshold = abi.decode(_stripSelector(data), (uint256));
            _changeThreshold(newThreshold);
        } else if (selector == this.signMessage.selector) {
            bytes memory messageData = abi.decode(_stripSelector(data), (bytes));
            _signMessage(messageData);
        } else if (selector == this.unsignMessage.selector) {
            bytes memory messageData = abi.decode(_stripSelector(data), (bytes));
            _unsignMessage(messageData);
        } else if (selector == this.enableModule.selector) {
            address module = abi.decode(_stripSelector(data), (address));
            _enableModule(module);
        } else if (selector == this.disableModule.selector) {
            (address prevModule, address module) = abi.decode(_stripSelector(data), (address, address));
            _disableModule(prevModule, module);
        } else if (selector == this.cancelByConsensus.selector) {
            bytes32 txHashArg = abi.decode(_stripSelector(data), (bytes32));
            _cancelByConsensus(txHashArg);
        } else if (selector == this.setMinExecutionDelay.selector) {
            uint32 delay = abi.decode(_stripSelector(data), (uint32));
            _setMinExecutionDelay(delay);
        } else {
            // H-3: Revert on unrecognized self-call selectors
            revert UnrecognizedSelfCall(selector);
        }
    }

    /**
     * @notice H-4: Assembly word-copy strip selector (gas efficient)
     * @dev L-4: Redundant length check removed — _executeSelfCall (the only caller) already
     *      validates data.length >= 4 before calling this function.
     *      Copies in 32-byte chunks; the final chunk may read up to 31 bytes past end of data,
     *      which the EVM zero-pads — safe and consistent with the Gnosis Safe pattern.
     */
    function _stripSelector(bytes memory data) internal pure returns (bytes memory) {
        bytes memory result;
        unchecked { result = new bytes(data.length - 4); } // caller validates data.length >= 4
        assembly {
            let src := add(data, 0x24)
            let dst := add(result, 0x20)
            let len := mload(result)
            for { let i := 0 } lt(i, len) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
        return result;
    }

    // ==================== Module Management ====================

    function _enableModule(address module) internal {
        if (module == address(0) || module == SENTINEL_MODULES)
            revert InvalidModule(module);
        if (modules[module] != address(0))
            revert ModuleAlreadyEnabled();
        if (moduleCount >= MAX_MODULES) revert MaxModulesReached();

        modules[module] = modules[SENTINEL_MODULES];
        modules[SENTINEL_MODULES] = module;
        unchecked { moduleCount++; } // bounded by MAX_MODULES check above

        emit EnabledModule(module);
    }

    /**
     * @dev WARNING: Enabled modules have unrestricted execution access — see execTransactionFromModule.
     *      Only enable audited, trusted modules.
     */
    function enableModule(address module) external onlySelf {
        _enableModule(module);
    }

    function _disableModule(address prevModule, address module) internal {
        if (module == address(0) || module == SENTINEL_MODULES)
            revert InvalidModule(module);
        if (modules[prevModule] != module)
            revert InvalidPrevModule(prevModule);

        modules[prevModule] = modules[module];
        modules[module] = address(0);
        unchecked { moduleCount--; } // module was verified enabled above

        emit DisabledModule(module);
    }

    function disableModule(address prevModule, address module) external onlySelf {
        _disableModule(prevModule, module);
    }

    function isModuleEnabled(address module) public view returns (bool) {
        return module != SENTINEL_MODULES && modules[module] != address(0);
    }

    /**
     * @notice Internal pagination logic shared by getModulesPaginated and getModules
     * @dev M-5: Extracted to prevent getModules() from making an external this.call,
     *      which would fail or return incorrect results if called from within a delegatecall
     *      context (where address(this) refers to the caller, not this wallet).
     */
    function _getModulesPaginated(
        address start,
        uint256 pageSize
    ) internal view returns (address[] memory array, address next) {
        array = new address[](pageSize);

        uint256 count = 0;
        next = modules[start];

        while (
            next != address(0) &&
            next != SENTINEL_MODULES &&
            count < pageSize
        ) {
            array[count] = next;
            next = modules[next];
            unchecked { count++; } // bounded by pageSize
        }

        assembly {
            mstore(array, count)
        }
    }

    /**
     * @notice Get paginated list of enabled modules (Zodiac IAvatar compatible)
     */
    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view returns (address[] memory array, address next) {
        return _getModulesPaginated(start, pageSize);
    }

    /**
     * @notice Get all enabled modules (limited to MAX_MODULES)
     * @dev M-5: Uses internal _getModulesPaginated — no external this.call.
     */
    function getModules() external view returns (address[] memory) {
        (address[] memory array, ) = _getModulesPaginated(SENTINEL_MODULES, MAX_MODULES);
        return array;
    }

    // ==================== Module Execution ====================

    /**
     * @notice Execute transaction from authorized module (Zodiac IAvatar compatible)
     * @dev Follows Safe's module trust model: enabled modules have unrestricted execution access.
     *      ⚠️ WARNING: Only enable audited, trusted modules. An enabled module can execute arbitrary
     *      transactions including DelegateCall to any target, addOwner, removeOwner, changeThreshold,
     *      enableModule, disableModule, and setMinExecutionDelay. The security gate is exclusively at
     *      enableModule, which requires owner multisig consensus.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) public onlyModule nonReentrant returns (bool success) {
        if (to == address(0)) revert InvalidDestinationAddress();

        if (operation == Enum.Operation.DelegateCall) {
            // H-2: Use high-level delegatecall consistently
            (success, ) = to.delegatecall(data);
        } else {
            (success, ) = to.call{value: value}(data);
        }

        if (success) {
            emit ExecutionFromModuleSuccess(msg.sender);
        } else {
            emit ExecutionFromModuleFailure(msg.sender);
        }
    }

    /**
     * @notice Legacy 3-param version for backward compatibility
     * @dev QV-M-2: Delegates to the 4-param version which enforces onlyModule and nonReentrant.
     *      No onlyModule here — msg.sender is unchanged on internal calls, so the 4-param
     *      version's onlyModule check is sufficient and avoids a redundant SLOAD.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bool success) {
        return execTransactionFromModule(to, value, data, Enum.Operation.Call);
    }

    /**
     * @notice Execute transaction from module and return data (Zodiac IAvatar compatible)
     * @dev Same trust model as execTransactionFromModule — unrestricted module access. See above.
     */
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external onlyModule nonReentrant returns (bool success, bytes memory returnData) {
        if (to == address(0)) revert InvalidDestinationAddress();

        if (operation == Enum.Operation.DelegateCall) {
            // H-2: Use high-level delegatecall consistently
            (success, returnData) = to.delegatecall(data);
        } else {
            (success, returnData) = to.call{value: value}(data);
        }

        if (success) {
            emit ExecutionFromModuleSuccess(msg.sender);
        } else {
            emit ExecutionFromModuleFailure(msg.sender);
        }
    }

    // ==================== View Functions ====================

    /**
     * @notice Get transaction hash (C-1: uses abi.encode for unambiguous encoding)
     */
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 _nonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(address(this), to, value, data, _nonce, block.chainid)
        );
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getOwnerCount() external view returns (uint256) {
        return owners.length;
    }

    function getTransaction(bytes32 txHash)
        external
        view
        returns (Transaction memory)
    {
        return transactions[txHash];
    }

    /**
     * @notice Check if an owner has a valid (current-epoch) approval for a transaction
     * @dev H-2: Returns false for approvals made before the owner was last removed.
     *      An approval made at version N is invalid after removal (which advances to version N+1).
     */
    function hasApproved(bytes32 txHash, address owner)
        external
        view
        returns (bool)
    {
        return _approvalValid(txHash, owner);
    }

    // ==================== EIP-1271 Signature Validation ====================

    /**
     * @notice Compute EIP-712 domain separator
     * @dev I-2: Includes name ("QuaiVault") and version ("1") fields for standard compliance
     *      and wallet UI display (MetaMask, Ledger Live etc. show these in signing dialogs).
     *      Computed fresh each call (not cached) for fork safety.
     */
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_SEPARATOR_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function encodeMessageData(bytes memory message) public view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encode(QUAIVAULT_MSG_TYPEHASH, keccak256(message))
        );
        return abi.encodePacked(
            bytes1(0x19), bytes1(0x01), domainSeparator(), messageHash
        );
    }

    function getMessageHash(bytes memory message) public view returns (bytes32) {
        return keccak256(encodeMessageData(message));
    }

    function signMessage(bytes calldata data) external onlySelf {
        _signMessage(data);
    }

    function _signMessage(bytes memory data) internal {
        bytes32 msgHash = getMessageHash(data);
        signedMessages[msgHash] = true;
        emit MessageSigned(msgHash, data);
    }

    /// @notice Revoke a previously signed message (M-NEW-3)
    function unsignMessage(bytes calldata data) external onlySelf {
        _unsignMessage(data);
    }

    function _unsignMessage(bytes memory data) internal {
        bytes32 msgHash = getMessageHash(data);
        if (!signedMessages[msgHash]) revert MessageNotSigned();
        signedMessages[msgHash] = false;
        emit MessageUnsigned(msgHash, data);
    }

    /**
     * @notice EIP-1271 signature validation
     * @dev I-3: This implementation uses a mapping-based (pre-approval) model, NOT ECDSA verification.
     *      The `_signature` parameter is intentionally ignored — any bytes value is accepted.
     *      Validity is determined purely by whether signMessage(abi.encode(_dataHash)) was executed
     *      via multisig consensus.
     *
     *      Workflow for integrators:
     *        1. Multisig proposes and executes: wallet.signMessage(abi.encode(messageHash))
     *        2. External protocol calls: wallet.isValidSignature(messageHash, anySig)
     *        3. Returns magic value 0x1626ba7e if pre-approved, 0xffffffff otherwise.
     *
     *      IMPORTANT: Protocols expecting live ECDSA signatures will NOT work without first
     *      pre-approving the message hash via multisig. This is a deliberate architectural choice
     *      to avoid ecrecover complexity and signature malleability risks.
     *
     * @param _dataHash The hash of the data to validate
     * @return 0x1626ba7e if message was pre-approved via multisig, 0xffffffff otherwise
     * @dev The signature parameter (I-5) is intentionally unnamed and ignored — see NatSpec above.
     */
    function isValidSignature(
        bytes32 _dataHash,
        bytes calldata /* _signature */  // I-5: intentionally ignored — mapping-based model (see NatSpec)
    ) external view override returns (bytes4) {
        bytes32 msgHash = getMessageHash(abi.encode(_dataHash));
        if (signedMessages[msgHash]) {
            return 0x1626ba7e; // IERC1271 magic value
        }
        return 0xffffffff;
    }

    // ==================== EIP-165 Interface Support ====================

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC1155HolderUpgradeable)
        returns (bool)
    {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1271).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // ==================== Receive / Fallback ====================

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    fallback() external payable {
        // M-1: Reject unknown function selectors with no value — almost always a caller bug
        // (wrong ABI, stale selector, misrouted call). Accept when msg.value > 0 to support
        // payment routers that include memo calldata alongside a native token transfer.
        if (msg.value == 0 && msg.data.length > 0) revert();
        emit Received(msg.sender, msg.value);
    }
}
