# QuaiVault Transaction Lifecycle Design

## Overview

This document captures the canonical design for QuaiVault's transaction lifecycle,
including the per-transaction timelock system (C-6), cancellation paths, expiration
validation, formal expiry cleanup, and failure handling.

The design is intentionally integrated rather than composable — security properties
are native to the contract, not dependent on correct module/guard configuration.
This eliminates the configuration-risk failure class that has affected composable
multisig stacks (e.g., Bybit, Feb 2025).

---

## Transaction Struct

Slot-packed to 4 storage slots (zero cost for timelock fields vs. prior layout):

```
slot 0: address to (20) | uint48 timestamp (6) | uint48 expiration (6)      = 32 bytes
slot 1: address proposer (20) | bool executed (1) | bool cancelled (1)
        | uint48 approvedAt (6) | uint32 executionDelay (4)                  = 32 bytes
slot 2: uint256 value
slot 3: bytes data (pointer)
```

**`approvedAt`** — Set exactly once when `_countValidApprovals` first reaches `threshold`.
Never cleared by revocation. Permanent on-chain record that quorum was reached.

**`executionDelay`** — `max(minExecutionDelay, requestedDelay)`, computed at proposal
time and permanently locked into the struct. Cannot change after proposal.
Self-calls force `executionDelay = 0` regardless of vault floor or requested delay.

---

## State Machine

```
                 ┌──────────────────────────────────────────────────┐
                 │                    PENDING                        │
                 │  approvedAt == 0, count < threshold               │
                 │                                                    │
                 │  * approveTransaction                             │
                 │  * revokeApproval                                 │
                 │  * cancelTransaction (proposer only)              │
                 └───────────────┬──────────────────────────────────┘
                                 │ _countValidApprovals first reaches threshold
                                 │ approvedAt = block.timestamp  [permanent, never cleared]
                                 │ emit ThresholdReached(txHash, approvedAt, executableAfter)
                 ┌───────────────▼──────────────────────────────────┐
                 │                    APPROVED                       │
                 │  approvedAt != 0, timelock not elapsed            │
                 │  (executionDelay == 0 -> this state is skipped)   │
                 │                                                    │
                 │  * approveTransaction (additional signers)        │
                 │  * revokeApproval (may block execution)           │
                 │  X cancelTransaction    [approvedAt != 0]         │
                 │  * cancelByConsensus (onlySelf, no delay)         │
                 │  X executeTransaction   [TimelockNotElapsed]      │
                 │     (self-calls skip this state -- execute now)   │
                 └───────────────┬──────────────────────────────────┘
                                 │ block.timestamp >= approvedAt + executionDelay
                 ┌───────────────▼──────────────────────────────────┐
                 │                   EXECUTABLE                      │
                 │  approvedAt != 0, delay elapsed, count >= thresh  │
                 │                                                    │
                 │  * executeTransaction (if count >= threshold)     │
                 │  * revokeApproval (drops below threshold: blocked)│
                 │  * cancelByConsensus (onlySelf)                   │
                 │  X cancelTransaction    [approvedAt != 0]         │
                 └───────┬──────────────┬───────────────────────────┘
                         │              │
                ┌────────▼────────┐   ┌─▼──────────────────────────┐
                │    EXECUTED     │   │        CANCELLED            │
                │   (terminal)    │   │  cancelled=true             │
                │                 │   │  expiredTxs[txHash]=false   │
                └─────────────────┘   └────────────────────────────┘

   EXPIRED transitions — can occur from PENDING, APPROVED, or EXECUTABLE:

   Any non-terminal state where expiration != 0 && block.timestamp > expiration:

                 ┌──────────────────────────────────────────────────┐
                 │                    EXPIRED                        │
                 │  cancelled=true, expiredTxs[txHash]=true          │
                 │  (terminal — formal cleanup via expireTransaction)│
                 └──────────────────────────────────────────────────┘
```

### Terminal State Matrix

| State | `executed` | `cancelled` | `expiredTxs[txHash]` |
|---|---|---|---|
| EXECUTED | true | false | false |
| CANCELLED (voluntary) | false | true | false |
| EXPIRED (formal) | false | true | true |

---

## Three Transaction Paths

### Path 1: Simple Quorum (no timelock, no expiration)

For day-to-day operations where owners are online and coordinating in real time.

```
minExecutionDelay = 0  (vault default)
proposeTransaction(to, value, data)  ->  requestedDelay defaults to 0
effectiveDelay = max(0, 0) = 0

Lifecycle: PENDING -> [threshold] -> immediately EXECUTABLE -> EXECUTED
```

`approvedAt` is still recorded and `ThresholdReached` is still emitted (indexer consistency),
but `executableAfter = approvedAt`. The APPROVED state collapses to zero duration.

### Path 2: Timelocked External Call

For high-value fund movements requiring a monitoring window.

```
minExecutionDelay = 86400  (24h vault floor, example)
proposeTransaction(to, value, data, expiration=0, requestedDelay=0)
effectiveDelay = max(86400, 0) = 86400

Lifecycle: PENDING -> [threshold] -> APPROVED (24h window) -> EXECUTABLE -> EXECUTED/FAILED
```

On execution **failure**: mark `executed = true`, emit `TransactionFailed(txHash, executor, returnData)`.
Never revert on external call failure. This is a terminal EXECUTED state — the tx will not
be re-executed. Indexers decode `returnData` for failure reason display.

On execution **success**: emit `TransactionExecuted(txHash, executor)`.

Self-calls (`to == address(this)`) always revert on failure — partial administrative
state changes (e.g., half-executed owner rotation) are unacceptable.

### Path 3: Self-Call (Administrative Operations)

For owner management, module configuration, message signing, cancellations, and
delay configuration changes. **Self-calls bypass the timelock entirely.**

```
proposeTransaction(address(this), 0, abi.encodeCall(wallet.addOwner, [newOwner]))

Lifecycle: PENDING -> [threshold] -> immediately EXECUTABLE -> EXECUTED
```

This is the correct behavior: administrative ops must be executable *faster* than
an in-flight timelocked transaction. This is what makes `cancelByConsensus`
viable — a cancellation self-call proposed after a malicious timelocked tx will
reach its execution window before the malicious tx does.

---

## Cancellation Design

### Invariant

`cancelTransaction` is permanently blocked once `approvedAt != 0`, regardless of
current approval count. This closes the revoke-then-cancel escape valve that would
allow the proposer to defeat the timelock by recruiting one approver to revoke.

### Two Paths

| State | Function | Who | Mechanism |
|---|---|---|---|
| `approvedAt == 0` | `cancelTransaction` | Proposer only | Direct call |
| `approvedAt != 0` | `cancelByConsensus` | Threshold quorum | Self-call (no delay) |

### `cancelByConsensus` Flow

1. Any owner proposes `cancelByConsensus(targetTxHash)` as a self-call
2. Threshold approvals collected on the cancellation proposal
3. `executeTransaction(cancelProposalHash)` — since `to == address(this)`, timelock skipped
4. `_executeSelfCall` dispatches to `_cancelByConsensus`
5. Target transaction is now `cancelled = true`

This does not require the original proposer's cooperation. Any quorum of honest owners
can cancel any approved transaction, at any point before execution.

### Shared `_cancelTransaction` Helper

Both cancellation paths call a shared internal helper that:
- Sets `transaction.cancelled = true`
- Clears `_approvalEpochs[txHash][owner]` for all current owners (QV-L2 fix — prevents ghost approval resurrection if addresses are reused)
- Emits `TransactionCancelled`

### Revocation During Timelock

`revokeApproval` is always permitted before execution. It does **not** clear `approvedAt`.
If revocations drop count below threshold during the timelock window, the transaction
enters a limbo state: `approvedAt != 0`, `count < threshold`. It cannot execute and
cannot be cancelled via `cancelTransaction`. Resolution requires either:

- Additional owners re-approve (restoring threshold), or
- Quorum consensus on `cancelByConsensus`

This limbo state is intentional. It is the on-chain signal that "quorum is contested —
human coordination required." Monitors should alert on it.

---

## Expiration Design

### At Proposal Time

```solidity
uint256 minimumExpiration = block.timestamp + effectiveDelay;
if (expiration != 0 && expiration <= minimumExpiration)
    revert ExpirationTooSoon(minimumExpiration);
```

Prevents a transaction from expiring before it is even executable. The revert
carries `minimumExpiration` so the frontend can suggest a valid value.

`expiration = 0` is always valid and means no expiry. The transaction can execute
at any future time, regardless of vault delay.

For timelocked vaults, the recommended default is **no expiration** (`expiration = 0`).
The timelock already provides structure. Expiration is opt-in for genuinely
time-sensitive operations (e.g., a trade that must execute within 48 hours).

### At Execution Time

```solidity
// Checked FIRST, before timelock — expired takes precedence
if (transaction.expiration != 0 && block.timestamp > transaction.expiration)
    revert TransactionIsExpired();
```

Boundary semantics: at `block.timestamp == expiration`, the transaction is still valid.
Only strictly after `expiration` does it become expired.

### Formal Expiry Cleanup

```solidity
function expireTransaction(bytes32 txHash) external
```

**Permissionless** — anyone can call. Not a griefing vector: only callable after
`block.timestamp > expiration`, at which point `_executeTransaction` would also
revert with `TransactionIsExpired`. The transaction is already dead; `expireTransaction`
formalizes it and reclaims storage.

Effects:
- Sets `cancelled = true` (reuses cancelled flag to block re-execution)
- Sets `expiredTxs[txHash] = true` (L-3: distinguishes expired from voluntarily cancelled)
- Calls `_clearApprovals(txHash)` (reclaims approval storage)
- Emits `TransactionExpired(txHash)` (distinct event for indexers)

---

## `approvedAt` Clock Semantics

| Event | Effect on `approvedAt` |
|---|---|
| `_countValidApprovals` first reaches `threshold` | Set to `block.timestamp` |
| Additional approvals beyond threshold | No change |
| `revokeApproval` drops count below threshold | **No change** — clock is permanent |
| Count restored to threshold by re-approval | **No change** — still the original timestamp |
| `cancelByConsensus` | Transaction cancelled; `approvedAt` irrelevant |

**Why permanent?** Resetting the clock on revocation would allow the proposer to collude
with one approver to cycle the clock indefinitely, defeating any timelock of any duration.

### Lazy Clock Start

If the threshold is lowered after a transaction was proposed (but before `approvedAt` was set),
the transaction may silently have enough valid approvals without `approvedAt` being recorded.

When `executeTransaction` is called in this scenario:
1. Detects `approvedAt == 0` with `_countValidApprovals >= threshold`
2. Sets `approvedAt = block.timestamp` and emits `ThresholdReached`
3. **Returns without reverting** — a revert would roll back the `approvedAt` assignment
4. Caller retries after the delay elapses

This is not a DoS vector: the state change (clock start) persists, and the caller
knows exactly when to retry via the `ThresholdReached` event.

---

## Epoch-Based Approval Invalidation (H-2)

Owner removal increments `ownerVersions[owner]`, atomically invalidating all their
in-flight approvals without iterating transaction storage:

```solidity
// Approval is valid iff:
_approvalEpochs[txHash][owner] == ownerVersions[owner] + 1
```

If a removed owner is re-added, old approvals remain invalid (new epoch required).
This prevents ghost approval resurrection — a critical security property for
hash-based (non-sequential) transaction systems.

---

## API Surface

### State Variables

```solidity
uint32 public minExecutionDelay;           // vault-level floor; 0 = simple quorum vault
mapping(bytes32 => bool) public expiredTxs; // L-3: true only for formally expired txs
```

### `proposeTransaction` Overloads

```solidity
// Simple (backward-compatible): no timelock, no expiration
function proposeTransaction(address to, uint256 value, bytes memory data)
    external onlyOwner returns (bytes32);

// With expiration only
function proposeTransaction(address to, uint256 value, bytes memory data, uint48 expiration)
    external onlyOwner returns (bytes32);

// Full control: expiration + per-transaction delay request
function proposeTransaction(address to, uint256 value, bytes memory data,
    uint48 expiration, uint32 requestedDelay)
    external onlyOwner returns (bytes32);
// effectiveDelay = max(minExecutionDelay, requestedDelay), stored in Transaction.executionDelay
```

### Cancellation & Expiry Functions

```solidity
// Pre-threshold cancellation (proposer only)
function cancelTransaction(bytes32 txHash) external onlyOwner;

// Post-threshold cancellation (onlySelf — requires multisig self-call)
function cancelByConsensus(bytes32 txHash) external onlySelf;

// Formal expiry cleanup (permissionless)
function expireTransaction(bytes32 txHash) external;

// Update vault-level minimum delay (onlySelf — requires multisig self-call)
function setMinExecutionDelay(uint32 delay) external onlySelf;
```

### Events

```solidity
// Transaction lifecycle
event TransactionProposed(bytes32 indexed txHash, address indexed proposer,
    address indexed to, uint256 value, bytes data, uint48 expiration, uint32 executionDelay);
event TransactionApproved(bytes32 indexed txHash, address indexed approver);
event ApprovalRevoked(bytes32 indexed txHash, address indexed owner);
event TransactionExecuted(bytes32 indexed txHash, address indexed executor);
event TransactionCancelled(bytes32 indexed txHash, address indexed canceller);

// Threshold and timelock
event ThresholdReached(bytes32 indexed txHash, uint48 approvedAt, uint256 executableAfter);
event TransactionFailed(bytes32 indexed txHash, address indexed executor, bytes returnData);
event TransactionExpired(bytes32 indexed txHash);

// Configuration
event MinExecutionDelayChanged(uint32 oldDelay, uint32 newDelay);

// Value reception
event Received(address indexed sender, uint256 amount);
```

### Errors

```solidity
error TransactionIsExpired();           // execution attempted after expiration
error TransactionNotExpired();          // expireTransaction called too early
error TimelockNotElapsed(uint256 executableAfter);  // carries when-to-retry timestamp
error ExpirationTooSoon(uint256 minimumExpiration); // carries minimum valid expiration
```

---

## Factory Integration

```solidity
// Simple: creates vault with minExecutionDelay = 0
function createWallet(address[] memory owners, uint256 threshold,
    bytes32 salt) external returns (address);

// Full: creates vault with non-zero minExecutionDelay from deployment
// minExecutionDelay must be <= MAX_EXECUTION_DELAY (30 days / 2,592,000 seconds)
// Reverts with ExecutionDelayTooLong() if exceeded
function createWallet(address[] memory owners, uint256 threshold,
    bytes32 salt, uint32 minExecutionDelay) external returns (address);

// Deterministic address prediction (CREATE2)
function predictWalletAddress(address deployer, bytes32 salt,
    address[] memory owners, uint256 threshold,
    uint32 minExecutionDelay) external view returns (address);

// initialize() gains corresponding parameter
function initialize(address[] memory owners, uint256 threshold,
    uint32 minExecutionDelay) external initializer;

// Factory constants and errors
uint32 public constant MAX_EXECUTION_DELAY = 30 days; // 2,592,000 seconds
error ExecutionDelayTooLong();
```

---

## Key Invariants (Summary)

1. `approvedAt` is set exactly once per transaction and never cleared
2. `executionDelay` is fixed at proposal time and immutable thereafter
3. Self-calls (`to == address(this)`) always have `executionDelay = 0` and never check the timelock
4. External call failures never revert — `TransactionFailed` emitted, state is terminal
5. `cancelTransaction` is permanently blocked once `approvedAt != 0`
6. `cancelByConsensus` is available (via quorum self-call) until execution
7. Expiration must exceed `block.timestamp + effectiveDelay` at proposal time
8. `expiration = 0` means no expiry — transaction lives forever
9. `minExecutionDelay` is the floor — individual transactions may exceed it, never go below
10. Expired transactions are formally closeable via permissionless `expireTransaction`
11. Owner removal atomically invalidates all their in-flight approvals (epoch-based, O(1))
