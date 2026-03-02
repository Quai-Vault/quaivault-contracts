# QuaiVault vs Gnosis Safe: Technical Comparison

A side-by-side comparison for developers and integrators evaluating QuaiVault against
the Gnosis Safe (now Safe{Wallet}) ecosystem.

---

## Architecture

### Safe{Wallet}

Safe is a **composable stack** — security properties are assembled from independent contracts:

```
Safe (core multisig)
  + Delay Modifier (optional timelock)
  + Transaction Guard (optional validation)
  + Zodiac Modules (optional automation)
  + Fallback Handler (EIP-1271, etc.)
```

Each layer is independently deployable, configurable, and removable. This maximizes
flexibility but introduces **configuration-risk** — a misconfigured or missing guard
can silently defeat security invariants. The Bybit incident (Feb 2025) demonstrated
this failure mode: the Safe itself was uncompromised, but the surrounding infrastructure
was exploited to bypass the multisig.

### QuaiVault

QuaiVault is an **integrated design** — security properties are native to the contract:

```
QuaiVault (multisig + timelock + expiration + failure handling)
  + Zodiac Modules (optional, for automation only)
```

Timelock, expiration, cancellation, and failure handling are built into the core contract.
They cannot be misconfigured because they are not independently configurable.
Module support is retained for automation use cases (DAO governance, social recovery)
via the standard Zodiac IAvatar interface.

---

## Transaction Model

| Property | Safe | QuaiVault |
|---|---|---|
| **Identification** | Sequential nonce | Content hash (`keccak256(to, value, data, nonce, chainId)`) |
| **Ordering** | Strict — nonce N must execute before N+1 | Unordered — any approved tx can execute independently |
| **Queuing** | Single queue, head-of-line blocking | Parallel — multiple txs in-flight simultaneously |
| **Replay protection** | Nonce increment | Hash uniqueness (monotonic nonce in hash preimage) |

### Implications for integrators

**Safe**: A stuck transaction at nonce N blocks all subsequent transactions. The only escape
is to execute or replace the stuck tx (submit a different tx with the same nonce). This is
well-understood but can cause operational delays.

**QuaiVault**: Any transaction can be cancelled or executed independently. A stuck tx does
not block others. The trade-off is that integrators must track transactions by hash rather
than sequential index.

---

## Timelock

| Property | Safe + Delay Modifier | QuaiVault |
|---|---|---|
| **Location** | External module (Zodiac Delay Modifier) | Native to core contract |
| **Configuration** | Separately deployed, attached to Safe | `minExecutionDelay` set at vault creation or via self-call |
| **Bypass risk** | Modifier can be removed or misconfigured | Cannot be removed — only adjustable via multisig consensus |
| **Per-tx override** | Not supported natively | `requestedDelay` parameter (can only exceed vault floor) |
| **Self-call behavior** | Same delay as external calls (unless Guard exempts) | Always immediate — `executionDelay` forced to 0 |
| **Clock start** | When tx is queued in Delay Modifier | When `_countValidApprovals` first reaches `threshold` |
| **Clock gaming** | N/A (no native clock) | Prevented — `approvedAt` set once, never cleared |

### Self-call bypass rationale

In QuaiVault, administrative operations (addOwner, removeOwner, changeThreshold,
enableModule, cancelByConsensus, setMinExecutionDelay) execute immediately once
quorum is reached. This is critical for security: if an attacker proposes a malicious
timelocked withdrawal, honest owners can propose and execute a `cancelByConsensus`
self-call *before* the malicious tx becomes executable.

In Safe, achieving this requires a Guard that exempts certain function selectors from
the Delay Modifier — additional configuration that must be correct.

---

## Cancellation

| Property | Safe | QuaiVault |
|---|---|---|
| **Pre-approval** | Replace tx at same nonce (proposer) | `cancelTransaction` (proposer only, `approvedAt == 0`) |
| **Post-approval** | `setTxNonce` to skip past it (requires Safe threshold) | `cancelByConsensus` self-call (requires vault threshold) |
| **Ordering impact** | Cancelling nonce N unblocks N+1 | No ordering impact — txs are independent |
| **Clock reset** | N/A | Impossible — `approvedAt` is permanent |

### QuaiVault cancellation invariant

Once `approvedAt` is set (quorum was reached), the proposer **cannot** unilaterally cancel.
This prevents the attack where a proposer colludes with one approver to revoke, cancel,
and re-propose with a reset timelock. Post-approval cancellation requires full quorum
consensus via `cancelByConsensus`.

---

## Expiration

| Property | Safe | QuaiVault |
|---|---|---|
| **Native support** | No | Yes — `expiration` field in Transaction struct |
| **Configuration** | Must be implemented via Guard logic | Per-transaction, set at proposal time |
| **Validation** | N/A | `expiration > block.timestamp + effectiveDelay` (guaranteed execution window) |
| **Cleanup** | N/A | `expireTransaction()` — permissionless, reclaims storage |
| **Zero expiration** | N/A | `expiration = 0` means no expiry |

---

## Failed Execution Handling

| Property | Safe | QuaiVault (external calls) | QuaiVault (self-calls) |
|---|---|---|---|
| **On revert** | Entire Safe tx reverts | `executed = true`, emit `TransactionFailed` | Entire tx reverts |
| **Re-execution** | Same nonce, retry | Terminal — cannot re-execute | N/A (state rolled back) |
| **Nonce impact** | Consumed on success only | Hash-based, no nonce queue | N/A |
| **Failure data** | Available in revert reason | Emitted in `TransactionFailed` event `returnData` | Propagated as revert |

### QuaiVault "Option B" rationale

External call failures emit `TransactionFailed` rather than reverting. This prevents
the scenario where a target contract intentionally reverts to keep the multisig tx
permanently stuck in an "approved but un-executable" state. The transaction is marked
terminal, and indexers/frontends surface the failure reason from `returnData`.

Self-calls revert on failure because partial administrative state changes (e.g.,
half-completed owner rotation) would leave the vault in an inconsistent state.

---

## Approval System

| Property | Safe | QuaiVault |
|---|---|---|
| **Storage** | Off-chain signatures collected, submitted in batch | On-chain per-owner approval mapping |
| **Revocation** | Not applicable (signatures are atomic) | `revokeApproval` — withdraw approval before execution |
| **Ghost approvals** | Signature replay mitigated by nonce | Epoch-based invalidation — owner removal atomically invalidates all their approvals (O(1)) |
| **Threshold changes** | Immediate effect on pending txs | Immediate effect; lazy clock start handles retroactive threshold crossing |

### Epoch-based approval invalidation

When an owner is removed, `ownerVersions[owner]` is incremented. All their in-flight
approvals become invalid instantly without iterating transaction storage. If the same
address is re-added, old approvals remain invalid (new epoch required). This is critical
for hash-based systems where there is no sequential nonce to invalidate.

---

## Module System (Zodiac Compatibility)

Both Safe and QuaiVault implement the Zodiac IAvatar interface:

```solidity
interface IAvatar {
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function isModuleEnabled(address module) external view returns (bool);
    function getModulesPaginated(address start, uint256 pageSize)
        external view returns (address[] memory, address next);
    function execTransactionFromModule(address to, uint256 value, bytes data, Operation op)
        external returns (bool);
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes data, Operation op)
        external returns (bool, bytes memory);
}
```

| Property | Safe | QuaiVault |
|---|---|---|
| **Module storage** | Linked list (sentinel 0x1) | Linked list (sentinel 0x1) — identical pattern |
| **Module limit** | Unlimited | MAX_MODULES = 50 |
| **Module execution** | Bypasses threshold, no timelock | Same — modules are trusted, bypass all checks |
| **DelegateCall** | Supported | Supported (required for MultiSend batching) |
| **3-param legacy** | `execTransactionFromModule(to, value, data)` | Supported via ISimpleModuleExecutor |
| **Module enablement** | `onlyOwner` (Safe threshold) | `onlySelf` (vault threshold) |

### Integrator note

Zodiac modules built for Safe (e.g., Baal DAO, Reality Module, Roles Modifier) are
ABI-compatible with QuaiVault. Modules call `execTransactionFromModule` which has the
same signature and semantics. QuaiVault additionally exposes `IOwnerManager` for
modules that need to modify ownership (e.g., SocialRecoveryModule).

---

## Proxy Pattern

| Property | Safe | QuaiVault |
|---|---|---|
| **Pattern** | ERC-1167 minimal proxy (clone) | ERC1967 constructor proxy |
| **Deployment gas** | ~45 bytes bytecode, minimal gas | Full proxy bytecode, ~3-5x more gas |
| **Upgradeability** | Non-upgradeable (by default) | Non-upgradeable (by design) |
| **Plain value transfers** | Works (standard EVM) | `receive()` on proxy handles directly — no DELEGATECALL needed |
| **CREATE2 prediction** | `keccak256(cloneBytecode)` (constant) | `keccak256(creationCode + constructorArgs)` (varies per wallet config) |

### Quai Network-specific consideration

On Quai Network, ERC-1167 clones cannot receive plain QUAI transfers from standard wallets.
The root cause: `quais.js` skips access list creation for type-0 transactions with empty
calldata, but ERC-1167's DELEGATECALL requires the implementation address in the access list.
QuaiVault uses a constructor-based ERC1967 proxy with its own `receive()` function to solve
this — plain value transfers are handled directly by the proxy without DELEGATECALL.

---

## Standards Support

| Standard | Safe | QuaiVault |
|---|---|---|
| **EIP-1271** (contract signatures) | Yes — signature verification against threshold | Yes — mapping-based pre-approval via multisig |
| **ERC-721** (NFT receiver) | Via Fallback Handler | Native — inherits `ERC721HolderUpgradeable` |
| **ERC-1155** (multi-token receiver) | Via Fallback Handler | Native — inherits `ERC1155HolderUpgradeable` |
| **ERC-165** (interface detection) | Via Fallback Handler | Native — `supportsInterface` |
| **Zodiac IAvatar** | Yes | Yes |

### EIP-1271 difference

Safe verifies signatures against the current owner set and threshold at verification time.
QuaiVault uses a mapping-based model: messages are pre-signed via multisig consensus
(`signMessage`), and `isValidSignature` checks the mapping. Messages can be unsigned
via `unsignMessage`. The signature parameter in `isValidSignature` is ignored.

---

## Event Comparison

Events that indexers/frontends must handle:

| Event | Safe | QuaiVault |
|---|---|---|
| Tx proposed | Off-chain (Safe Transaction Service) | `TransactionProposed(txHash, proposer, to, value, data, expiration, executionDelay)` |
| Tx approved | Off-chain (signature collected) | `TransactionApproved(txHash, approver)` |
| Approval revoked | N/A | `ApprovalRevoked(txHash, owner)` |
| Tx executed | `ExecutionSuccess` / `ExecutionFailure` | `TransactionExecuted(txHash, executor)` / `TransactionFailed(txHash, executor, returnData)` |
| Tx cancelled | N/A (nonce replacement) | `TransactionCancelled(txHash, canceller)` |
| Tx expired | N/A | `TransactionExpired(txHash)` |
| Threshold reached | N/A | `ThresholdReached(txHash, approvedAt, executableAfter)` |
| Owner added | `AddedOwner(owner)` | `OwnerAdded(owner)` |
| Owner removed | `RemovedOwner(owner)` | `OwnerRemoved(owner)` |
| Threshold changed | `ChangedThreshold(threshold)` | `ThresholdChanged(threshold)` |
| Module enabled | `EnabledModule(module)` | `ModuleEnabled(module)` |
| Module disabled | `DisabledModule(module)` | `ModuleDisabled(module)` |
| ETH/QUAI received | `SafeReceived(sender, value)` | `Received(sender, amount)` |
| Delay changed | N/A (Delay Modifier event) | `MinExecutionDelayChanged(oldDelay, newDelay)` |
| Message signed | `SignMsg(msgHash)` | `MessageSigned(msgHash, data)` |
| Message unsigned | N/A | `MessageUnsigned(msgHash, data)` |

Key difference: Safe's transaction lifecycle is largely off-chain (Safe Transaction Service
API + collected signatures). QuaiVault's entire lifecycle is on-chain — every state
transition emits an event. This makes indexing simpler (single source of truth) but
means more on-chain gas for the approval process.

---

## Security Model Summary

| Property | Safe | QuaiVault |
|---|---|---|
| **Architecture** | Composable (modules + guards + handlers) | Integrated (single contract) |
| **Configuration risk** | High — security depends on correct assembly | Low — security properties are structural |
| **Timelock** | Opt-in module (can be removed) | Native (cannot be removed, only adjusted) |
| **Nonce model** | Sequential (head-of-line blocking) | Hash-based (parallel execution) |
| **Failed call handling** | Reverts | Option B (terminal failure, no re-execution) |
| **Approval invalidation** | Signature-based (no on-chain state) | Epoch-based (O(1) invalidation on owner removal) |
| **Clock gaming** | N/A | Prevented by permanent `approvedAt` |
| **Battle-testing** | 5+ years, securing $100B+ | New — audited, 266 unit tests + 49 E2E on-chain tests |
| **Ecosystem** | Mature (Safe Apps, Transaction Service, UI) | Emerging (custom indexer + frontend required) |

---

## Migration Considerations

For teams considering a move from Safe to QuaiVault:

1. **Module compatibility**: Zodiac modules are ABI-compatible. Modules calling
   `execTransactionFromModule` will work without modification.

2. **Transaction tracking**: Replace nonce-based tracking with hash-based tracking.
   All state transitions are on-chain events — no dependency on the Safe Transaction Service.

3. **Signature collection**: Replace off-chain signature aggregation with on-chain
   `approveTransaction` calls. Each approval is a separate on-chain transaction.

4. **Cancellation flow**: Replace nonce-bumping with `cancelTransaction` (pre-approval)
   or `cancelByConsensus` (post-approval). No head-of-line blocking.

5. **Timelock**: No separate Delay Modifier deployment needed. Set `minExecutionDelay`
   at wallet creation or via `setMinExecutionDelay` self-call.

6. **EIP-1271**: Replace threshold-verified signatures with pre-approved message mapping.
   Call `signMessage` via multisig before the message needs to be verified.
