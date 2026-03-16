# QuaiVault vs Gnosis Safe: Technical Comparison

## Executive Summary

QuaiVault and Safe (Gnosis Safe) are both multisig wallet contracts, but they make
fundamentally different architectural choices. Where Safe prioritizes composability —
letting integrators assemble security from independent, swappable parts — QuaiVault
prioritizes correctness by default. QuaiVault bakes timelock enforcement, expiration,
structured cancellation, epoch-based approval invalidation, and approval revocation
directly into the core contract, eliminating entire categories of misconfiguration that
have historically led to multisig compromises. The result is a system where critical
security invariants are guaranteed by the contract itself, not by the operator's ability
to correctly configure and maintain an ecosystem of external modules and guards.

**Safe** is a composable stack. The core contract handles signature verification,
execution, and gas refunds. Everything else — timelock, transaction guards, module
guards, DelegateCall restrictions, token callbacks, EIP-1271, message signing — is
assembled from independent contracts that can be added, removed, or replaced. This gives
integrators maximum flexibility but introduces configuration risk: security depends on
correctly assembling and maintaining multiple contracts. Safe supports 4 signature types
(ECDSA, eth_sign, approved hash, contract/EIP-1271), off-chain signature collection, and
a built-in gas refund system for relayer reimbursement. v1.5.0 adds Module Guards for
optional per-module access control. Following the Bybit hack, Safe released **Guardrail**
(Aug 2025), an optional guard that restricts DelegateCall to an allowlist of approved
contracts with time-delayed additions.

**QuaiVault** is an integrated design. Timelock, expiration, cancellation, failure
handling, DelegateCall hardening, and message signing are built into a single contract.
Security properties are structural — they cannot be misconfigured because they are not
independently configurable. The trade-off is less flexibility: no transaction guards, no
gas refund system, no off-chain signatures. QuaiVault uses on-chain approvals (one tx per
signer), hash-based transaction identification (no head-of-line blocking), and epoch-based
approval invalidation (O(1) invalidation on owner removal). DelegateCall is blocked by
default with a consensus-togglable flag and defense-in-depth implementation slot guarding.
It natively supports approval revocation and message un-signing, which Safe does not.

| | Safe v1.5.0 | QuaiVault |
|---|---|---|
| **Design** | Composable (assemble from parts) | Integrated (single contract) |
| **Timelock** | Opt-in, removable (Delay Modifier) | Native, non-removable |
| **Signatures** | Off-chain (4 types) | On-chain approvals only |
| **Tx ordering** | Sequential nonce (blocking) | Hash-based (parallel) |
| **Failed calls** | Non-reverting, nonce consumed | Non-reverting, marked terminal |
| **Gas refund** | Built-in (ETH/ERC-20) | None |
| **Guards** | Transaction Guard + Module Guard | None (structural security) |
| **DelegateCall hardening** | Opt-in guard (Guardrail, Aug 2025) | Native `delegatecallDisabled` flag (default: blocked) |
| **Approval revocation** | Not supported | Native `revokeApproval` |
| **Message un-signing** | Not supported | Native `unsignMessage` |
| **Max owners** | Unlimited (gas-bounded) | 20 (enforced constant) |
| **Ecosystem** | Mature (5+ years, $100B+) | Emerging (new, audited) |

Both contracts share the Zodiac module interface (IAvatar) — modules are cross-compatible.
Both treat enabled modules as fully trusted (unrestricted execution access). Both use
linked-list module storage with sentinel 0x1.

---

Safe references in this document describe **v1.5.0** behavior (the latest release, July 2024).
The repo has moved from `safe-global/safe-smart-account` to `safe-fndn/safe-smart-account`.
Notable changes from v1.3.0 (the most widely deployed version): contract renaming
(`GnosisSafe` → `Safe`, `GnosisSafeProxy` → `SafeProxy`), Module Guards (`IModuleGuard`),
`ExtensibleFallbackHandler`, `checkSignatures` executor parameter, ERC-777 support,
chain-specific CREATE2 deployments, `SafeToL2Setup` for automatic L2 singleton switching,
virtual hooks (`onBeforeExecTransaction`, `onBeforeExecTransactionFromModule`), `require()`
replaced with gas-optimized assembly reverts (`revertWithError`), and `GS400` prevention of
setting fallback handler to self. Where v1.5.0 introduced a feature not present in v1.3.0,
it is noted.

Post-v1.5.0 developments (not yet released): **Guardrail** (Aug 2025) — an optional Safe
Guard that maintains a DelegateCall allowlist with time-delayed additions, created in
response to the Bybit hack. **EIP-7702 support** — on the `main` branch but unreleased;
allows `address(this)` as owner for delegated EOAs.

---

## Architecture

### Safe{Wallet}

Safe is a **composable stack** — security properties are assembled from independent contracts:

```
Safe (core multisig + gas refund + signature verification)
  + Delay Modifier (optional timelock — external Zodiac module)
  + Transaction Guard (optional pre/post validation on owner-signed txs)
  + Module Guard (optional pre/post validation on module-initiated txs — v1.5.0)
  + Zodiac Modules (optional automation)
  + Fallback Handler (EIP-1271, token callbacks, extensible per-selector routing)
  + SignMessageLib (on-chain message signing via DELEGATECALL)
  + SafeToL2Setup (automatic L2 singleton switching — v1.5.0)
```

Each layer is independently deployable, configurable, and removable. This maximizes
flexibility but introduces **configuration-risk** — a misconfigured or missing guard
can silently defeat security invariants. The Bybit incident (Feb 2025) demonstrated
this failure mode: the Safe itself was uncompromised, but the surrounding infrastructure
was exploited to bypass the multisig.

### QuaiVault

QuaiVault is an **integrated design** — security properties are native to the contract:

```
QuaiVault (multisig + timelock + expiration + failure handling + message signing)
  + Zodiac Modules (optional, for automation only)
```

Timelock, expiration, cancellation, failure handling, and message signing are built into the
core contract. They cannot be misconfigured because they are not independently configurable.
Module support is retained for automation use cases (DAO governance, social recovery)
via the standard Zodiac IAvatar interface.

---

## Transaction Model

| Property | Safe | QuaiVault |
|---|---|---|
| **Execution function** | `execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures)` — 10 parameters | `proposeTransaction` → `approveTransaction` → `executeTransaction(txHash)` — 3-step lifecycle |
| **Identification** | Sequential nonce | Content hash (`keccak256(address(this), to, value, data, nonce, chainId)`) |
| **Ordering** | Strict — nonce N must execute before N+1 | Unordered — any approved tx can execute independently |
| **Queuing** | Single queue, head-of-line blocking | Parallel — multiple txs in-flight simultaneously |
| **Replay protection** | Nonce increment (consumed before execution) | Hash uniqueness (monotonic nonce in hash preimage) |
| **Operation types** | `Call` and `DelegateCall` | `Call` only for user txs; `DelegateCall` only via modules (blocked by default — CR-1) |
| **Batching** | Via MultiSend library (DELEGATECALL) | Via MultiSend library (module DELEGATECALL, requires `delegatecallDisabled=false`) |

### Execution model difference

**Safe**: Transaction proposal, signature collection, and execution happen in a single
atomic `execTransaction` call. Signatures are collected off-chain (EIP-712) and submitted
together. The function hashes the tx data, increments the nonce, verifies signatures,
optionally calls the transaction guard, executes, handles gas refund, and emits the result
— all in one transaction.

**QuaiVault**: The lifecycle is split across multiple on-chain transactions:
1. **Propose**: Owner submits tx details, stored on-chain with a content hash
2. **Approve**: Each owner submits individual on-chain approvals
3. **Execute**: Any owner triggers execution once quorum + timelock are satisfied

This means QuaiVault pays more gas (one tx per approval) but provides full on-chain
auditability and native approval revocation.

### Implications for integrators

**Safe**: A stuck transaction at nonce N blocks all subsequent transactions. The only escape
is to execute or replace the stuck tx (submit a different tx with the same nonce). This is
well-understood but can cause operational delays.

**QuaiVault**: Any transaction can be cancelled or executed independently. A stuck tx does
not block others. The trade-off is that integrators must track transactions by hash rather
than sequential index.

---

## Signature Types

| Type | Safe | QuaiVault |
|---|---|---|
| **ECDSA (EIP-712)** | Yes — `v ∈ {27, 28}`, `r` = signer's r, `s` = signer's s | No — approvals are on-chain transactions |
| **eth_sign** | Yes — `v > 30` (adjusted), message prefix applied before ecrecover | No |
| **Approved hash** | Yes — `v == 1`, `r` = approver address; checks `approvedHashes[owner][hash]` or `executor == owner` | N/A — all approvals are on-chain by default |
| **Contract signature (EIP-1271)** | Yes — `v == 0`, `r` = contract address, `s` = offset to signature data | N/A — approvals are on-chain txs; any address (EOA or contract) can be an owner |

### Safe signature verification details

`checkNSignatures` iterates through packed 65-byte signature chunks. Signatures must be
ordered by owner address (ascending) to prevent duplicates. The `executor` parameter
(new in v1.5.0) controls whether `v==1` (approved hash) signatures auto-approve for
`msg.sender` — when `executor == address(0)` (used by CompatibilityFallbackHandler for
EIP-1271), no owner can auto-approve, preventing the "caller is owner" bypass.

### QuaiVault approval model

QuaiVault does not use packed signatures. Each owner calls `approveTransaction(txHash)`
as a separate on-chain transaction. Approvals are stored in a mapping and validated at
execution time via `_countValidApprovals`. This eliminates signature malleability concerns
and provides native revocation via `revokeApproval`.

---

## Gas Refund System

| Property | Safe | QuaiVault |
|---|---|---|
| **Built-in gas refund** | Yes — `handlePayment(gasUsed, baseGas, gasPrice, gasToken, refundReceiver)` | No |
| **Gas token support** | Yes — any ERC-20 or native ETH | N/A |
| **Refund receiver** | Configurable per-tx; defaults to `tx.origin` | N/A |
| **Gas price cap** | `min(gasPrice, tx.gasprice)` for native token refunds | N/A |
| **Zero-gas-price mode** | `gasPrice == 0` + `safeTxGas == 0` → internal call must succeed (reverts if it fails) | N/A |

Safe's gas refund system allows relayers to submit transactions on behalf of owners and
get reimbursed in ETH or any ERC-20 token. This enables gasless UX for Safe owners.

QuaiVault has no built-in relayer reimbursement. Each owner pays their own gas for
approval and execution transactions. Relay infrastructure must be built externally if needed.

---

## Timelock

| Property | Safe + Delay Modifier | QuaiVault |
|---|---|---|
| **Location** | External module (Zodiac Delay Modifier) | Native to core contract |
| **Configuration** | Separately deployed, attached to Safe | `minExecutionDelay` set at vault creation or via self-call |
| **Bypass risk** | Modifier can be removed or misconfigured | Cannot be removed — only adjustable via multisig consensus |
| **Per-tx override** | Not supported natively | `requestedDelay` parameter (can only exceed vault floor) |
| **Self-call behavior** | Delay Modifier does not apply to `execTransaction` (owner-signed) — only to module-initiated transactions | Always immediate — `executionDelay` forced to 0 |
| **Clock start** | When tx is queued in Delay Modifier | When `_countValidApprovals` first reaches `threshold` |
| **Clock gaming** | N/A (no native clock) | Prevented — `approvedAt` set once, never cleared |

### Timelock architecture difference

The Delay Modifier and QuaiVault's native timelock operate at different levels:

- **Safe + Delay Modifier**: The Delay Modifier sits between modules and the Safe. It
  only delays transactions initiated via `execTransactionFromModule`. Direct owner-signed
  transactions via `execTransaction` are never routed through the Delay Modifier — they
  execute immediately once signatures are collected. This means owner-signed self-calls
  are naturally undelayed.

- **QuaiVault**: The timelock is integrated into the core contract and applies to all
  external calls regardless of how they are proposed. Self-calls are explicitly exempted
  (`executionDelay` forced to 0). Module-initiated calls bypass the timelock entirely
  (modules are trusted).

The key difference is removability: Safe owners can `disableModule` to remove the Delay
Modifier at any time, eliminating the timelock entirely. QuaiVault's `minExecutionDelay`
can be adjusted to 0 via self-call, but the timelock mechanism itself cannot be removed
from the contract.

---

## Cancellation

| Property | Safe | QuaiVault |
|---|---|---|
| **Pre-approval** | Replace tx at same nonce (submit different tx with same nonce) | `cancelTransaction` (proposer only, `approvedAt == 0`) |
| **Post-approval** | Execute a no-op tx at same nonce (e.g., 0-value self-send, requires Safe threshold) | `cancelByConsensus` self-call (requires vault threshold) |
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
| **Cleanup** | N/A | `expireTransaction()` — permissionless, clears approval storage (tx struct retained) |
| **Zero expiration** | N/A | `expiration = 0` means no expiry |

---

## Failed Execution Handling

| Property | Safe | QuaiVault (external calls) | QuaiVault (self-calls) |
|---|---|---|---|
| **On revert** | Outer tx succeeds, emits `ExecutionFailure` | `executed = true`, emits `TransactionFailed` | Entire tx reverts |
| **Re-execution** | No — nonce consumed, must re-propose | Terminal — cannot re-execute | N/A (state rolled back) |
| **Nonce impact** | Consumed on both success and failure | Hash-based, no nonce queue | N/A |
| **Failure data** | `ExecutionFailure` event (no revert data); in zero-gas-price mode (`safeTxGas == 0` + `gasPrice == 0`), actual revert reason propagated via assembly (v1.5.0 replaced generic GS013) | Emitted in `TransactionFailed` event `returnData` | Propagated as revert |
| **Special case** | `safeTxGas == 0` + `gasPrice == 0` → reverts on failure (for `estimateGas` compatibility) | N/A | N/A |

Both Safe and QuaiVault avoid reverting the outer transaction on internal call failure.
The key difference is in what happens next:

- **Safe**: The nonce advances, freeing the queue. The failed transaction is gone — owners
  must re-propose and re-sign a new transaction at the next nonce. In zero-gas-price mode
  (`safeTxGas == 0` + `gasPrice == 0`), v1.5.0 propagates the actual revert reason via
  `returndatacopy` rather than the generic `GS013` error used in v1.3.0.
- **QuaiVault**: The transaction is marked terminal (`executed = true`). Owners must
  propose a new transaction with a fresh hash. No queue is blocked because there is no queue.

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
| **Primary model** | Off-chain EIP-712 signatures collected and submitted together | On-chain per-owner approval mapping |
| **On-chain approval** | `approveHash(bytes32)` — sets `approvedHashes[msg.sender][hash] = 1` | `approveTransaction(bytes32)` — sets approval mapping + checks threshold |
| **Revocation** | Not possible — off-chain signatures can't be revoked; on-chain `approveHash` has no revoke function | `revokeApproval(bytes32)` — withdraw approval before execution |
| **Ghost approvals** | Signature replay mitigated by nonce | Epoch-based invalidation — owner removal atomically invalidates all their approvals (O(1)) |
| **Threshold changes** | Immediate effect on next `execTransaction` call | Immediate effect; lazy clock start handles retroactive threshold crossing |
| **Signer ordering** | Required — signatures must be sorted by owner address (ascending) | Not required — approvals are independent on-chain txs |

### Epoch-based approval invalidation

When an owner is removed, `ownerVersions[owner]` is incremented. All their in-flight
approvals become invalid instantly without iterating transaction storage. If the same
address is re-added, old approvals remain invalid (new epoch required). This is critical
for hash-based systems where there is no sequential nonce to invalidate.

---

## Owner Management

| Property | Safe | QuaiVault |
|---|---|---|
| **Add owner** | `addOwnerWithThreshold(owner, threshold)` | `addOwner(owner)` (self-call) |
| **Remove owner** | `removeOwner(prevOwner, owner, threshold)` — requires linked list traversal | `removeOwner(owner)` (self-call) — internal array swap-and-pop |
| **Swap owner** | `swapOwner(prevOwner, oldOwner, newOwner)` — atomic replace | Not supported — must remove then add |
| **Access control** | `authorized` modifier (`msg.sender == address(this)`) | `onlySelf` modifier (same semantics) |
| **Threshold coupling** | Owner add/remove functions take threshold as parameter — can change threshold atomically | Threshold changed via separate `changeThreshold` self-call |
| **Owner storage** | Linked list — `prevOwner` required for remove/swap (caller must know list order) | Array — caller only provides the owner address (internal swap-and-pop) |
| **Self as owner** | Explicitly blocked (`owner == address(this)` reverts with GS203; unreleased EIP-7702 branch allows it for delegated EOAs) | Explicitly blocked — `address(this)` and `SENTINEL_MODULES` (0x1) both revert with `InvalidOwnerAddress` |
| **Max owners** | Unlimited (gas-bounded only) | `MAX_OWNERS = 20` (enforced constant — bounds gas for `_countValidApprovals`) |

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
| **Module execution** | Bypasses threshold; optionally guarded via Module Guard (v1.5.0) | Modules are trusted, bypass all checks (no module guard) |
| **Module Guard** | `IModuleGuard` — pre/post checks on module-initiated txs (v1.5.0) | Not supported — modules are fully trusted once enabled |
| **DelegateCall via modules** | Supported; optionally restricted via Guardrail guard (allowlist + time-delay, Aug 2025) | Blocked by default (`delegatecallDisabled=true`); opt-in via consensus toggle. When enabled, BB-L-4 guards the ERC1967 implementation slot |
| **Self-call prevention** | No — modules can target the Safe itself | No — modules can target the vault itself (same trust model as Safe) |
| **3-param legacy** | `execTransactionFromModule(to, value, data)` — removed in v1.5.0 | Supported via ISimpleModuleExecutor |
| **Module enablement** | `authorized` (self-call via `execTransaction`, requires threshold) | `onlySelf` (vault threshold) |

### Module Guards (Safe v1.5.0)

Safe v1.5.0 introduces `IModuleGuard` — an optional guard that intercepts module-initiated
transactions. The execution flow in `ModuleManager` is:

1. `preModuleExecution` — loads module guard, calls `checkModuleTransaction(to, value, data, operation, msg.sender)` which returns a `guardHash`
2. `execute` — performs the actual call/delegatecall
3. `postModuleExecution` — calls `checkAfterModuleExecution(guardHash, success)`, then emits `ExecutionFromModuleSuccess` or `ExecutionFromModuleFailure`

The guard receives the calling module's address, enabling per-module access control policies.
Set via `setModuleGuard(address)` (requires `authorized`), validated via ERC-165 (`interfaceId = 0x58401ed8`) before acceptance.

QuaiVault does not have module guards. Enabled modules have unrestricted access — the
security model relies on only enabling audited, trusted modules and disabling them when
no longer needed.

### Integrator note

Zodiac modules built for Safe (e.g., Baal DAO, Reality Module, Roles Modifier) are
ABI-compatible with QuaiVault. Modules call `execTransactionFromModule` which has the
same signature and semantics. QuaiVault additionally exposes `IOwnerManager` for
modules that need to modify ownership (e.g., SocialRecoveryModule).

**Note on 3-param legacy**: Safe v1.5.0 removed the 3-param `execTransactionFromModule(to, value, data)` overload from `ModuleManager`. Modules using this signature must be updated to pass `Enum.Operation.Call` as the 4th parameter. QuaiVault retains the 3-param version via `ISimpleModuleExecutor` for backward compatibility.

---

## Guard System

| Property | Transaction Guard | Module Guard (v1.5.0) | QuaiVault |
|---|---|---|---|
| **Interface** | `ITransactionGuard` (`0xe6d7a83a`) | `IModuleGuard` (`0x58401ed8`) | None |
| **Pre-check** | `checkTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures, msgSender)` | `checkModuleTransaction(to, value, data, operation, module)` → returns `guardHash` | N/A |
| **Post-check** | `checkAfterExecution(txHash, success)` | `checkAfterModuleExecution(guardHash, success)` | N/A |
| **Set function** | `setGuard(address)` | `setModuleGuard(address)` | N/A |
| **Storage** | `GUARD_STORAGE_SLOT` (keccak256 slot) | `MODULE_GUARD_STORAGE_SLOT` (keccak256 slot) | N/A |
| **ERC-165 validation** | Yes — checked before accepting | Yes — checked before accepting | N/A |
| **Access control** | `authorized` (self-call) | `authorized` (self-call) | N/A |

Guards are Safe's mechanism for enforcing custom policies (e.g., allowlisting destinations,
blocking certain function selectors, enforcing spending limits). QuaiVault achieves some
of these goals structurally (timelock, expiration) but does not support arbitrary
pre/post-execution hooks.

---

## DelegateCall Hardening

The Bybit hack (Feb 2025, $1.46B loss) exploited DelegateCall to overwrite the Safe proxy's
implementation storage slot. Both projects have responded, but with fundamentally different
approaches:

| Property | Safe (Guardrail) | QuaiVault (CR-1 + BB-L-4) |
|---|---|---|
| **Approach** | Optional guard contract (allowlist + time-delay) | Native contract flag (`delegatecallDisabled`) + implementation slot guard |
| **Default** | DelegateCall unrestricted (opt-in to Guardrail) | DelegateCall blocked by default (opt-in to allow) |
| **Granularity** | Per-target allowlist (approve specific contracts for DelegateCall) | Binary on/off for all DelegateCall operations |
| **Time-delay** | Configurable delay on allowlist additions | N/A — toggle is immediate via consensus |
| **Removability** | Guard can be removed by owners (`setGuard(address(0))`) | Flag can be toggled but the mechanism itself cannot be removed |
| **Implementation slot protection** | No dedicated protection (relies on Guardrail allowlist) | BB-L-4: pre/post snapshot of ERC1967 slot around every DelegateCall; reverts with `ImplementationSlotTampered` if changed |
| **Release** | Aug 2025 (separate contract, not in core Safe) | Built into core contract |
| **Deployment** | Requires separate deployment + `setGuard` call | Configured at wallet creation (`initialize` 4th param) |

### Architectural difference

**Safe's Guardrail** is a composable guard — consistent with Safe's design philosophy. It
maintains an allowlist of contracts approved for DelegateCall, with a configurable time-delay
for additions (preventing instant allowlisting of malicious targets). Removals are immediate.
It covers both owner-signed and module-initiated transactions. As a guard, it can be removed
by owners at any time.

**QuaiVault's CR-1** is a native contract feature — consistent with QuaiVault's integrated
philosophy. When `delegatecallDisabled=true` (the default), all DelegateCall operations via
modules revert with `DelegateCallDisabled()`. When DelegateCall is allowed, BB-L-4 provides
defense-in-depth by snapshotting the ERC1967 implementation slot before/after every
DelegateCall and reverting if the slot changed. This catches the specific Bybit attack
vector (implementation slot overwrite) even when DelegateCall is enabled.

The key trade-off: Safe's Guardrail offers per-target granularity (allow MultiSend but block
unknown contracts), while QuaiVault's CR-1 is all-or-nothing but cannot be accidentally
misconfigured or removed.

---

## Proxy Pattern

| Property | Safe | QuaiVault |
|---|---|---|
| **Pattern** | Custom proxy (`SafeProxy`) — singleton stored in storage slot 0 | ERC1967 constructor proxy |
| **Proxy bytecode** | Minimal — all-assembly `fallback()`, handles `masterCopy()` inline | OpenZeppelin ERC1967Proxy |
| **Initialization** | `setup(owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver)` — 8 params, optional setup DELEGATECALL + deployment payment | `initialize(owners, threshold, minExecutionDelay, delegatecallDisabled)` — 4 params |
| **Setup DELEGATECALL** | Optional `to.delegatecall(data)` during setup (enables `SafeToL2Setup`, module pre-configuration) | Not supported |
| **Deployment payment** | Built-in — can pay deployer in ETH or ERC-20 during setup | Not supported |
| **Upgradeability** | Non-upgradeable by default (no `changeMasterCopy`); migration possible via `SafeMigration` DELEGATECALL to overwrite slot 0 | Non-upgradeable (by design — no write path to implementation slot) |
| **`receive()` behavior** | Native `receive()` on singleton emits `SafeReceived(sender, value)` — proxy forwards via DELEGATECALL | `receive()` on proxy handles directly — no DELEGATECALL needed |
| **CREATE2 prediction** | `bytecodeHash = keccak256(proxyCreationCode + singleton)`, `salt = keccak256(keccak256(initializer), saltNonce)` — varies per wallet config | `keccak256(creationCode + constructorArgs)` — varies per wallet config |
| **Chain-specific deployment** | `createChainSpecificProxyWithNonce` — includes `chainId` in salt (v1.5.0) | Not applicable — Quai Network is a single L1 |
| **On-chain address prediction** | Removed in v1.5.0 — must compute off-chain using `proxyCreationCode()` | `predictWalletAddress` on factory |
| **Factory functions** | `createProxyWithNonce`, `createProxyWithNonceL2`, `createChainSpecificProxyWithNonce`, `createChainSpecificProxyWithNonceL2` | `createWallet` (three overloads: 3-param, 4-param with `minExecutionDelay`, 5-param with `delegatecallDisabled`) |

### Safe setup complexity

Safe's `setup` function does significantly more than QuaiVault's `initialize`:
- Calls `setupOwners` (linked list + threshold)
- Optionally sets fallback handler
- Calls `setupModules` which optionally DELEGATECALLs to an arbitrary contract (used for `SafeToL2Setup` to auto-switch singleton on L2s, or to pre-enable modules)
- Optionally pays the deployer via `handlePayment`

This flexibility enables advanced deployment patterns (e.g., deploy + configure modules +
pay relayer atomically) but increases the attack surface of the setup transaction.

### SafeToL2Setup (v1.5.0)

`SafeToL2Setup` is called via the optional setup DELEGATECALL. It checks `chainId()`:
if not on chain 1 (Ethereum mainnet), it overwrites `singleton` (slot 0) with the L2
singleton address. This allows the same CREATE2 deployment transaction to produce a `Safe`
on mainnet and a `SafeL2` on L2s — both at the same address.

### Quai Network-specific consideration

On Quai Network, proxy contracts that rely on DELEGATECALL in their `receive()` path
cannot receive plain QUAI transfers from standard wallets. The root cause: `quais.js`
skips access list creation for type-0 transactions with empty calldata, but DELEGATECALL
requires the implementation address in the access list. QuaiVault uses a constructor-based
ERC1967 proxy with its own `receive()` function to solve this — plain value transfers
are handled directly by the proxy without DELEGATECALL.

---

## Standards Support

| Standard | Safe | QuaiVault |
|---|---|---|
| **EIP-1271** (contract signatures) | Yes — signature verification against threshold; v1.5.0 passes `address(0)` as executor to block auto-approval | Yes — mapping-based pre-approval via multisig |
| **ERC-721** (NFT receiver) | Via Fallback Handler (`onlyFallback` guard prevents direct calls to handler) | Native — inherits `ERC721HolderUpgradeable` |
| **ERC-1155** (multi-token receiver) | Via Fallback Handler (`onlyFallback` guard) | Native — inherits `ERC1155HolderUpgradeable` |
| **ERC-777** (token receiver) | Via Fallback Handler — `tokensReceived` callback (v1.5.0); requires ERC-1820 registry registration | Not supported |
| **ERC-165** (interface detection) | Via Fallback Handler; per-Safe dynamic registration via `ExtensibleFallbackHandler` (v1.5.0) | Native — `supportsInterface` on implementation |
| **EIP-712** (typed structured data) | Yes — `SAFE_TX_TYPEHASH` for transactions, `SAFE_MSG_TYPEHASH` for messages, `domainSeparator()` | Yes — `DOMAIN_SEPARATOR_TYPEHASH`, `QUAIVAULT_MSG_TYPEHASH` |
| **Zodiac IAvatar** | Yes | Yes |

### EIP-1271 difference

**Safe**: The `CompatibilityFallbackHandler.isValidSignature` has two paths:
1. **Empty signature** → checks `signedMessages[messageHash] != 0` (pre-approved via `SignMessageLib.signMessage`)
2. **Non-empty signature** → calls `safe.checkSignatures(address(0), messageHash, signature)` — the `address(0)` executor prevents any owner from auto-approving via the `v==1` (approved hash) signature type

**QuaiVault**: Messages are pre-signed via multisig consensus (`signMessage` self-call),
and `isValidSignature` checks the `signedMessages[msgHash]` mapping. Messages can be
unsigned via `unsignMessage` self-call. The signature parameter in `isValidSignature`
is ignored entirely.

### Message signing difference

**Safe**: `SignMessageLib` is a separate library contract called via DELEGATECALL. It writes
to the Safe's `signedMessages` storage mapping from the library's execution context. This
means message signing requires a full `execTransaction` (threshold signatures + nonce
consumption) targeting the SignMessageLib address with `DelegateCall` operation.

**QuaiVault**: `signMessage` and `unsignMessage` are native `onlySelf` functions. They are
proposed and executed like any other self-call transaction (propose → approve → execute,
no timelock). QuaiVault also supports `unsignMessage` — Safe has no equivalent for revoking
a signed message.

### `onlyFallback` modifier (Safe v1.5.0)

The `HandlerContext.onlyFallback` modifier verifies that the fallback handler is being
called via the Safe's `fallback()` dispatch (by reading the Safe's fallback handler storage
slot and comparing to `address(this)`). This is a **best-effort** guard to prevent tokens
from being sent directly to the handler contract (where they would be permanently locked)
rather than to the Safe itself.

### ExtensibleFallbackHandler (Safe v1.5.0)

Safe v1.5.0 introduces `ExtensibleFallbackHandler` as an alternative to the classic
`CompatibilityFallbackHandler`. It provides:

- **Per-selector method routing** — each Safe can register custom handler contracts for
  specific function selectors via `setSafeMethod(bytes4, bytes32)`
- **Per-domain EIP-712 signature verification** — each Safe can delegate EIP-1271
  verification for specific EIP-712 domains to custom `ISafeSignatureVerifier` contracts
- **Dynamic ERC-165** — per-Safe interface registration via `setSupportedInterface`

QuaiVault has no equivalent — its token callbacks and EIP-1271 are compiled into the
implementation contract. This is simpler but less extensible.

---

## Error Handling

| Property | Safe | QuaiVault |
|---|---|---|
| **Error format** | String error codes (`GS001`, `GS020`, etc.) via `revertWithError` assembly | Custom Solidity errors (`NotEnoughApprovals()`, `TimelockNotElapsed()`, etc.) |
| **Gas efficiency** | v1.5.0 uses assembly `revertWithError` — avoids Solidity's string ABI encoding overhead | Standard Solidity custom errors — 4-byte selector, minimal gas |
| **Decoding** | Requires error code lookup table (GS001 = "threshold not set", etc.) | Self-documenting — error name describes the problem |

### Safe error codes (selected)

| Code | Meaning |
|---|---|
| GS001 | Threshold not set (contract not initialized) |
| GS010 | Not enough gas for execution |
| GS013 | Safe transaction failed (v1.3.0 only — removed in v1.5.0; replaced by actual revert propagation in zero-gas-price mode) |
| GS020 | Signatures data too short |
| GS025 | Hash not approved (approved hash signature type) |
| GS026 | Invalid owner provided (wrong order or not an owner) |
| GS100 | Modules already initialized |
| GS101 | Invalid module address |
| GS200 | Owners already set up |
| GS203 | Invalid owner address |
| GS300 | Guard does not implement ITransactionGuard |
| GS301 | Module guard does not implement IModuleGuard (v1.5.0) |
| GS400 | Fallback handler cannot be set to self (v1.5.0) |

---

## Event Comparison

Events that indexers/frontends must handle:

| Event | Safe | QuaiVault |
|---|---|---|
| Setup | `SafeSetup(initiator, owners, threshold, initializer, fallbackHandler)` | No events during init — owners and threshold set silently; query `getOwners()` and `threshold()` |
| Tx proposed | Off-chain (Safe Transaction Service) | `TransactionProposed(txHash, proposer, to, value, data, expiration, executionDelay)` |
| Tx approved | Off-chain (signature collected) or on-chain `ApproveHash(hash, owner)` | `TransactionApproved(txHash, approver)` |
| Approval revoked | N/A | `ApprovalRevoked(txHash, owner)` |
| Tx executed (success) | `ExecutionSuccess(txHash, payment)` | `TransactionExecuted(txHash, executor)` |
| Tx executed (failure) | `ExecutionFailure(txHash, payment)` | `TransactionFailed(txHash, executor, returnData)` |
| Module tx executed | `ExecutionFromModuleSuccess(module)` / `ExecutionFromModuleFailure(module)` | `ExecutionFromModuleSuccess(module)` / `ExecutionFromModuleFailure(module)` — same events |
| Tx cancelled | N/A (nonce replacement) | `TransactionCancelled(txHash, canceller)` |
| Tx expired | N/A | `TransactionExpired(txHash)` |
| Threshold reached | N/A | `ThresholdReached(txHash, approvedAt, executableAfter)` |
| Owner added | `AddedOwner(owner)` | `OwnerAdded(owner)` |
| Owner removed | `RemovedOwner(owner)` | `OwnerRemoved(owner)` |
| Threshold changed | `ChangedThreshold(threshold)` | `ThresholdChanged(threshold)` |
| Module enabled | `EnabledModule(module)` | `ModuleEnabled(module)` |
| Module disabled | `DisabledModule(module)` | `ModuleDisabled(module)` |
| Module guard changed | `ChangedModuleGuard(moduleGuard)` (v1.5.0) | N/A — no module guard support |
| Tx guard changed | `ChangedGuard(guard)` | N/A — no transaction guard |
| Fallback handler changed | `ChangedFallbackHandler(handler)` | N/A — no fallback handler |
| ETH/QUAI received | `SafeReceived(sender, value)` | `Received(sender, amount)` |
| Delay changed | N/A (Delay Modifier event) | `MinExecutionDelayChanged(oldDelay, newDelay)` |
| Message signed | `SignMsg(msgHash)` (via SignMessageLib) | `MessageSigned(msgHash, data)` |
| Message unsigned | N/A | `MessageUnsigned(msgHash, data)` |
| DelegateCall toggled | N/A (Guardrail has own events) | `DelegatecallDisabledChanged(disabled)` |
| Recovery config cleared | N/A | `RecoveryConfigCleared(wallet)` (SocialRecoveryModule) |

**SafeL2 events** (v1.5.0): The `SafeL2` contract overrides the virtual hooks to emit
additional events with full calldata:
- `SafeMultiSigTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures, additionalInfo)` — where `additionalInfo = abi.encode(nonce, msg.sender, threshold)`
- `SafeModuleTransaction(module, to, value, data, operation)`

These emit full tx data in event logs so standard event-based indexers can reconstruct
transaction details on L2s. The base `Safe` contract emits no events containing full tx
data (requires a tracing node to reconstruct from calldata).

Key difference: Safe's transaction lifecycle is largely off-chain (Safe Transaction Service
API + collected signatures). QuaiVault's entire lifecycle is on-chain — every state
transition emits an event. This makes indexing simpler (single source of truth) but
means more on-chain gas for the approval process.

---

## Security Model Summary

| Property | Safe | QuaiVault |
|---|---|---|
| **Architecture** | Composable (modules + guards + handlers) | Integrated (single contract) |
| **Configuration risk** | High — security depends on correct assembly of layers | Low — security properties are structural |
| **Timelock** | Opt-in module (can be removed) | Native (cannot be removed, only adjusted) |
| **Nonce model** | Sequential (head-of-line blocking) | Hash-based (parallel execution) |
| **Failed call handling** | Non-reverting — emits `ExecutionFailure`, nonce consumed | Non-reverting — emits `TransactionFailed`, marked terminal |
| **DelegateCall hardening** | Guardrail guard (opt-in allowlist + time-delay, Aug 2025) | Native `delegatecallDisabled` (blocked by default) + BB-L-4 impl slot guard |
| **Module trust model** | Optional Module Guard (v1.5.0) for pre/post validation | Fully trusted — no module guard |
| **Guard system** | Transaction Guard + Module Guard — arbitrary pre/post hooks | None — security is structural, not policy-based |
| **Max owners** | Unlimited | 20 (bounds gas for approval counting) |
| **Gas refund** | Built-in (ETH or ERC-20 relayer reimbursement) | None — each signer pays their own gas |
| **Signature model** | 4 types (ECDSA, eth_sign, approved hash, contract) — off-chain primary | On-chain approvals only |
| **Approval invalidation** | Signature-based (no on-chain state to invalidate) | Epoch-based (O(1) invalidation on owner removal) |
| **Clock gaming** | N/A (no native clock) | Prevented by permanent `approvedAt` |
| **Message un-signing** | Not supported | Native `unsignMessage` |
| **Battle-testing** | 5+ years, securing $100B+ | New — audited (4 rounds, 47+ attack vectors), 345 unit tests + 53 E2E on-chain tests |
| **Ecosystem** | Mature (Safe Apps, Transaction Service, UI, Guard/Module marketplace) | Emerging (custom indexer + frontend required) |

---

## Migration Considerations

For teams considering a move from Safe to QuaiVault:

1. **Module compatibility**: Zodiac modules are ABI-compatible. Modules calling
   `execTransactionFromModule` (4-param version) will work without modification.
   Modules using the 3-param legacy signature are also supported via `ISimpleModuleExecutor`.

2. **Transaction tracking**: Replace nonce-based tracking with hash-based tracking.
   All state transitions are on-chain events — no dependency on the Safe Transaction Service.

3. **Signature collection**: Replace off-chain signature aggregation with on-chain
   `approveTransaction` calls. Each approval is a separate on-chain transaction.
   This increases gas cost but provides native revocation and full on-chain auditability.

4. **Cancellation flow**: Replace nonce-bumping with `cancelTransaction` (pre-approval)
   or `cancelByConsensus` (post-approval). No head-of-line blocking.

5. **Timelock**: No separate Delay Modifier deployment needed. Set `minExecutionDelay`
   at wallet creation or via `setMinExecutionDelay` self-call.

6. **EIP-1271**: Replace threshold-verified signatures with pre-approved message mapping.
   Call `signMessage` via multisig before the message needs to be verified. Unlike Safe,
   messages can be revoked via `unsignMessage`.

7. **Gas refund**: Safe's built-in relayer reimbursement has no equivalent. If gasless
   UX is needed, build external relay infrastructure.

8. **Guards**: Safe's Transaction Guard and Module Guard policies must be reimplemented
   as operational procedures or custom modules. QuaiVault's timelock and expiration
   cover some guard use cases structurally.

9. **DelegateCall**: Safe allows unrestricted DelegateCall by default; Guardrail is opt-in.
   QuaiVault blocks DelegateCall by default. If your modules require DelegateCall (e.g.,
   MultiSend batching), deploy with `delegatecallDisabled=false` or toggle it post-deploy
   via consensus. The BB-L-4 implementation slot guard provides defense-in-depth when
   DelegateCall is enabled.

10. **Owner management**: Safe's `swapOwner` (atomic replace) and threshold-coupled
   `addOwnerWithThreshold`/`removeOwner` must be replaced with separate self-call
   transactions for each operation.

---

## Summary

Safe and QuaiVault represent two ends of the multisig design spectrum. Safe gives you
a toolkit — powerful and flexible, but only as secure as the configuration its operators
maintain. QuaiVault gives you a vault — opinionated and self-contained, where the
security properties hold regardless of operator sophistication.

**What QuaiVault gains by integrating everything into a single contract:**

- **Timelock that cannot be removed.** Safe's Delay Modifier can be disabled by any
  transaction that meets threshold. QuaiVault's `minExecutionDelay` is enforced at the
  contract level — the only way to change it is through the timelock itself.

- **Approvals that can be revoked.** Safe's `approveHash` is permanent and irreversible.
  QuaiVault owners can call `revokeApproval` at any time before execution, giving signers
  an escape hatch if circumstances change after signing.

- **Messages that can be un-signed.** Safe's `SignMessageLib` writes a permanent mapping
  entry with no removal function. QuaiVault's `unsignMessage` lets the multisig revoke
  EIP-1271 approvals, closing a vector where a stale signed message could be exploited
  indefinitely.

- **Transactions that cannot block each other.** Safe's sequential nonce means a stuck
  or contested transaction blocks everything behind it. QuaiVault's hash-based
  identification allows any number of transactions to proceed in parallel.

- **Owner removal that instantly invalidates all approvals.** Safe requires no action on
  pending approvals when an owner is removed — their `approveHash` entries persist.
  QuaiVault's epoch-based system invalidates every approval from a removed owner in O(1),
  with zero iteration over pending transactions.

- **Failed transactions that are final.** Safe consumes the nonce on failure, leaving
  no on-chain record of what happened. QuaiVault marks failed transactions as terminal
  with a `TransactionFailed` event, preserving a complete audit trail.

- **Expiration built in.** Safe transactions live forever unless executed or nonce-bumped.
  QuaiVault transactions carry a deadline — after expiration, anyone can call
  `expireTransaction` to finalize them, preventing stale approvals from being executed
  months later.

- **DelegateCall blocked by default.** Safe allows unrestricted DelegateCall; its Guardrail
  guard (Aug 2025) is opt-in and removable. QuaiVault blocks all module DelegateCall
  operations by default (`delegatecallDisabled=true`). When DelegateCall is enabled, the
  BB-L-4 implementation slot guard provides defense-in-depth by catching the specific
  Bybit attack vector. The flag cannot be removed from the contract — only toggled by
  consensus.

- **Bounded owner count.** Safe has no owner limit — gas costs for signature verification
  and owner iteration grow unboundedly. QuaiVault enforces `MAX_OWNERS = 20`, guaranteeing
  that `_countValidApprovals` costs at most ~126,000 gas regardless of configuration.

**What QuaiVault trades away:**

- No off-chain signature aggregation (every approval is an on-chain transaction)
- No built-in gas refund system for relayer reimbursement
- No transaction guards or module guards (security is structural, not policy-based)
- No atomic owner swap (`swapOwner` must be two separate self-call transactions)
- A smaller ecosystem and shorter track record

For custody use cases where security correctness matters more than integration
flexibility — where the priority is ensuring that no configuration mistake can
silently weaken the wallet — QuaiVault's integrated architecture provides stronger
guarantees with fewer moving parts.
