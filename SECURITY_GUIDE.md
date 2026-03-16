# QuaiVault Security Guide for Wallet Owners

An honest assessment of what QuaiVault protects against, what it doesn't, and what
wallet owners must do themselves. This document is written for operators managing
real funds, not for marketing.

---

## Realistic Attack Vectors

Ordered by severity. These are the ways a QuaiVault wallet can actually be compromised.

### 1. Key Compromise + Self-Call Bypass

**Severity: Critical**

If an attacker obtains `threshold` private keys, **the timelock does not protect you**.
Self-calls (owner management, threshold changes, module enablement) execute immediately
once quorum is reached. The attacker can take over the wallet in minutes:

```
T+0:00  Attacker proposes addOwner(attackerAddress)      — self-call, no delay
T+0:30  Attacker approves with compromised keys           — quorum met, executes immediately
T+1:00  Attacker proposes changeThreshold(1)              — self-call, no delay
T+1:30  Attacker approves + executes                      — solo control achieved
T+2:00  Attacker drains wallet via external call           — threshold=1, no meaningful resistance
```

The entire takeover happens in minutes. The timelock only delays **external calls** (fund
transfers, contract interactions). Every administrative operation bypasses it by design —
this is correct behavior (you need fast admin ops for incident response), but it means
key compromise at threshold is total loss.

**Why self-calls bypass the timelock**: If a malicious timelocked withdrawal is in-flight,
honest owners must be able to propose and execute a `cancelByConsensus` self-call *faster*
than the malicious transaction's delay window. If self-calls were also timelocked, cancellation
would be impossible.

**Your defense**:
- Use hardware wallets (Ledger, Trezor, Tangem) for all owner keys
- Distribute keys geographically — no two keys in the same building
- Set threshold high relative to owner count (e.g., 3-of-5, not 2-of-5)
- Never store key material in cloud storage, email, or chat
- Rotate keys periodically via addOwner/removeOwner self-calls

### 2. Module = God Mode

**Severity: Critical (if a vulnerable module is enabled)**

An enabled module bypasses threshold, timelock, and all access controls. It can execute
arbitrary `Call` or `DelegateCall` on behalf of the wallet with zero approval required.

**DelegateCall is especially dangerous**: it executes code in the wallet's storage context.
A malicious or buggy module using DelegateCall could overwrite ownership, threshold, or
any storage slot directly — bypassing every safety check in the contract.

Module enablement requires multisig consensus (`onlySelf`), so an attacker can't enable
a module without `threshold` approvals. But once a module is enabled, any external caller
that can trigger the module's execution function has full access to the wallet.

**DelegateCall is disabled by default (CR-1).** See the dedicated section below for details.

**Your defense**:
- Only enable modules that have been independently audited
- Review module source code before enabling — understand exactly what it can do
- Regularly audit which modules are enabled: call `getModulesPaginated(0x1, 50)`
- Disable modules immediately when no longer needed
- Keep `delegatecallDisabled = true` (the default) unless you specifically need MultiSend batching
- The built-in SocialRecoveryModule and MultiSend library have been audited alongside
  the core contract. Third-party Zodiac modules have not.

### 3. Social Recovery Guardian Takeover

**Severity: High (if guardians are compromised)**

If an attacker compromises `guardianThreshold` guardian keys, they can replace all owners:

```
T+0:00    Attacker calls initiateRecovery(newOwners=[attacker], threshold=1)
T+0:30    Compromised guardians call approveRecovery
T+24:00   Attacker calls executeRecovery — owners replaced, wallet taken over
```

The SocialRecoveryModule enforces a minimum 1-day recovery period. During this window,
owners see the `RecoveryInitiated` event and can call `cancelRecovery`.

Recoveries also have an **expiration deadline** of `executionTime + recoveryPeriod` (2x total
lifetime from initiation). If the attacker does not execute within this window, anyone can
call `expireRecovery` to permissionlessly clean up the stale recovery. Additionally, when
any recovery executes successfully, all other pending recoveries for that wallet are
automatically invalidated — preventing attackers from queueing multiple recovery attempts.

**But**: If owners have lost all their keys (the scenario recovery is designed for),
there is no way to cancel. Guardian compromise in that situation is unrecoverable.

**Your defense**:
- Choose guardians who are independent of each other (different organizations, jurisdictions)
- Set guardian threshold high (e.g., 3-of-5 guardians, not 2-of-3)
- Use a recovery period longer than the 1-day minimum for high-value wallets
- Monitor `RecoveryInitiated` events with automated alerting
- Ensure at least one owner key is always accessible for emergency cancellation
- Never make wallet owners also be guardians — that defeats the purpose

### 4. Frontend / Indexer Deception (The Bybit Vector)

**Severity: High**

In the Feb 2025 Bybit hack ($1.4B), the Gnosis Safe contract was uncompromised. The
attack targeted the signing interface — it displayed legitimate-looking transaction data
while the actual on-chain calldata was malicious. Owners signed what they thought was
a routine transaction.

QuaiVault is equally vulnerable to this class of attack. If the frontend or indexer is
compromised, it could show "Send 1 QUAI to vendor" while the actual calldata is
`enableModule(attackerModule)`. Since this is a self-call, it executes immediately once
quorum is reached.

**The contract cannot prevent this.** It faithfully executes whatever calldata owners approve.

**Your defense**:
- **Always verify calldata on-chain** before approving — decode the raw transaction data
  using a block explorer or independent tool, not the same frontend used to propose it
- Use multiple independent frontends to cross-check transaction details
- For high-value transactions, have at least two owners independently decode and verify
  the calldata before any owner approves
- Run your own indexer instance rather than depending on a shared service
- Treat any frontend as potentially compromised — it is an input device, not a trusted authority

### 5. Threshold-1 Compromise + Social Engineering

**Severity: Medium**

An attacker has `threshold - 1` keys and needs one more honest owner to approve:

- Proposes a legitimate-looking transaction with a subtle payload difference
- Contacts the remaining owner with urgency ("we need to move funds now")
- The honest owner approves without carefully verifying calldata
- **External call**: the timelock provides a window for other owners to catch and cancel it
- **Self-call**: executes immediately — no recovery window

**Your defense**:
- Establish an out-of-band verification protocol among owners (phone call, in-person)
- Never approve under time pressure — the timelock exists precisely for this
- Set a policy: no approvals without independent calldata verification by each signer

---

## What the Contract Defends Against

These attack vectors are structurally prevented by QuaiVault's design. No operational
action is needed — the contract handles them automatically.

### Clock Gaming

`approvedAt` (the timestamp when quorum was first reached) is set exactly once and
**never cleared**. If approvals drop below threshold via revocation and later recover,
the original clock stands. This prevents the attack where a proposer colludes with one
approver to cycle revoke → cancel → re-propose → get fresh timelock indefinitely.

### Ghost Approvals After Owner Removal

When an owner is removed, `ownerVersions[owner]` is incremented. All their in-flight
approvals become instantly invalid without iterating transaction storage (O(1)). If the
same address is later re-added, old approvals remain invalid — a new approval epoch
is required. This prevents removed owners' stale approvals from being counted toward
quorum on any pending transaction.

### Head-of-Line Blocking

Transactions are identified by content hash, not sequential nonce. Any approved transaction
can execute independently — a stuck or malicious transaction does not block others. There
is no "nonce N must execute before N+1" ordering constraint.

### Expired Transaction Exploitation

Expiration is checked **before** the timelock in the execution path. An expired transaction
cannot be executed even if the timelock has elapsed and quorum is met. Anyone can call
`expireTransaction()` to formally close an expired transaction and reclaim storage.

### Proposer Cancel Abuse

`cancelTransaction` (proposer-only cancel) is permanently blocked once `approvedAt != 0`
(quorum was reached at any point). This prevents the attack where a proposer colludes with
one approver: approve → revoke → proposer cancels → re-propose with fresh timelock.
Post-approval cancellation requires full quorum consensus via `cancelByConsensus`.

### Reentrancy

`executeTransaction` is protected by OpenZeppelin's `nonReentrant` modifier. A malicious
target contract cannot re-enter the wallet during execution.

### Storage and Gas Griefing

All mappings are O(1) lookup — no unbounded iteration exists anywhere in the contract.
Hundreds of thousands of transactions, approvals, or signed messages have zero impact on
gas costs for any operation. There is no way to grief the wallet by inflating storage.

---

## Operational Security Recommendations

### Threshold Configuration

| Use Case | Recommended Setup | Rationale |
|---|---|---|
| Personal wallet | 2-of-3 owners | Lose one key, still operational |
| Team treasury | 3-of-5 owners | Majority required, tolerates 2 compromised keys |
| Protocol treasury | 4-of-7 or 5-of-9 | High bar, geographic distribution essential |
| Cold storage | 3-of-5 + timelock (24h+) | Timelock gives monitoring window for external calls |

A threshold of 1 is technically valid but provides zero multisig protection — it is
functionally equivalent to an EOA. Never use threshold=1 for any wallet holding
meaningful value.

### Timelock Configuration

`minExecutionDelay` is the vault-level floor applied to all external calls.
Individual transactions can request a longer delay but never a shorter one.

| Setting | Behavior |
|---|---|
| `minExecutionDelay = 0` | Simple quorum vault — external calls execute immediately after threshold |
| `minExecutionDelay = 300` (5 min) | Light monitoring window — catches obvious errors |
| `minExecutionDelay = 86400` (24h) | Standard security — gives owners a full day to review and cancel |
| `minExecutionDelay = 604800` (7d) | High security — maximum monitoring window, slower operations |

**Self-calls always execute immediately regardless of `minExecutionDelay`.** This is by
design — see "Key Compromise + Self-Call Bypass" above for the rationale.

The factory enforces a maximum of **30 days** (2,592,000 seconds) for `minExecutionDelay`
at deployment. Wallets can change their delay after deployment via `setMinExecutionDelay(newDelay)`
self-call (requires multisig consensus, takes effect immediately), which has no upper bound.

### Monitoring Checklist

Set up automated alerts for these on-chain events:

| Event | Why it matters |
|---|---|
| `TransactionProposed` | Every new proposal — verify you recognize the proposer and the calldata |
| `ThresholdReached` | Quorum crossed — the timelock clock has started. Review immediately. |
| `TransactionExecuted` | Confirm expected transactions executed. Investigate unexpected ones. |
| `TransactionFailed` | External call failed — decode `returnData` for the reason. Terminal state. |
| `OwnerAdded` / `OwnerRemoved` | Ownership changed. If unexpected, assume compromise. |
| `ThresholdChanged` | Threshold changed. If unexpected, assume compromise. |
| `ModuleEnabled` / `ModuleDisabled` | Module configuration changed. Verify the module address. |
| `RecoveryInitiated` | Recovery started — if unexpected, call `cancelRecovery` immediately. |
| `RecoveryInvalidated` | A pending recovery was invalidated because another recovery executed. |
| `RecoveryExpiredEvent` | A recovery expired and was cleaned up. Investigate if unexpected. |
| `RecoveryConfigCleared` | Guardian configuration was deleted after a successful recovery. New owners must reconfigure guardians. |
| `MinExecutionDelayChanged` | Timelock changed. A delay reduction could weaken security. |
| `DelegatecallDisabledChanged` | DelegateCall hardening toggled. If set to `false`, investigate immediately. |

**The most critical alert is `RecoveryInitiated`.** You have until `executionTime + recoveryPeriod`
(2x the recovery period from initiation, minimum 48 hours total lifetime) before the recovery
either executes and replaces all owners, or expires and becomes permissionlessly cleanable.

### Transaction Verification Protocol

Before approving any transaction:

1. **Read the raw calldata** — not the frontend's interpretation of it
2. **Decode the function selector** — first 4 bytes identify the function being called
3. **Verify the `to` address** — is it the expected recipient or contract?
4. **Check if it's a self-call** — `to == walletAddress` means administrative operation,
   executes immediately (no timelock)
5. **For self-calls: understand exactly what it does** — addOwner? changeThreshold?
   enableModule? These are irreversible once executed.
6. **Cross-check with at least one other owner** via out-of-band communication

### Social Recovery Best Practices

- **Guardian independence**: Guardians should not know each other, should be in different
  jurisdictions, and should have no shared infrastructure
- **Guardian threshold**: Set high enough that compromising a majority is impractical.
  For 5 guardians, require 3-of-5 or 4-of-5.
- **Recovery period**: The contract enforces a 1-day minimum. For high-value wallets,
  use 7 days or longer to give owners maximum time to detect and cancel
- **Recovery expiration**: Recoveries expire at `executionTime + recoveryPeriod` (2x total
  lifetime from initiation). After expiration, anyone can call `expireRecovery` to clean up
  stale recoveries. This prevents abandoned recoveries from permanently blocking new ones.
- **Automatic invalidation**: When a recovery executes, all other pending recoveries for
  that wallet are automatically invalidated. This ensures stale recoveries with pre-change
  guardian approvals cannot survive an ownership change.
- **Test recovery**: Periodically verify that guardians are still accessible and that
  the recovery flow works. A recovery system that fails when needed is worse than none.
- **Separation of roles**: Wallet owners should NOT also be guardians. Guardians are
  a backup path for when owners lose access — making the same people both defeats
  the redundancy model.

---

## DelegateCall Hardening (CR-1)

### Why This Exists

On February 21, 2025, the Bybit exchange lost **$1.46 billion** in a single transaction.
The Gnosis Safe multisig contract was uncompromised — the attacker used a supply-chain
attack on the Safe{Wallet} developer infrastructure to trick signers into approving a
transaction that included a `DelegateCall` to a malicious contract. That contract overwrote
the Safe's implementation storage slot (slot 0), giving the attacker full control.

This was the largest smart contract exploit in history. It exploited a single EVM primitive:
**`DELEGATECALL` executes external code in the calling contract's storage context.** Any
storage slot — owners, threshold, modules, signed messages — can be overwritten.

Trail of Bits, in their September 2025 cold storage security guide, now explicitly
recommends: *"Disable delegatecall functionality entirely"* for wallets holding significant
value. Gnosis Safe attempted to add a Module Guard in v1.5.0 to restrict module operations
but dropped the feature due to contract bytecode size constraints.

QuaiVault ships a simpler, more effective solution: a `delegatecallDisabled` flag that
blocks the operation type entirely at the contract level.

### How It Works

```solidity
bool public delegatecallDisabled;  // true by default

// In execTransactionFromModule:
if (operation == Enum.Operation.DelegateCall) {
    if (delegatecallDisabled) revert DelegateCallDisabled();
    // ... existing BB-L-4 implementation slot check ...
}
```

**Default: `true` (disabled).** All new wallets deployed through the factory have
DelegateCall blocked from the moment of creation.

**Toggle:** Owners can change this via a multisig self-call:
```
setDelegatecallDisabled(false)  // allow DelegateCall (opt-in, requires consensus)
setDelegatecallDisabled(true)   // block DelegateCall (re-harden)
```

**Event:** `DelegatecallDisabledChanged(bool disabled)` is emitted on every toggle for
indexer tracking.

### What DelegateCall Disabling Closes

When `delegatecallDisabled = true`, the following attack vectors are **permanently closed**:

| Attack Vector | Description |
|---|---|
| **Bybit-style slot overwrite** | DelegateCall to a contract that overwrites the ERC1967 implementation slot |
| **Arbitrary storage corruption** | DelegateCall to a contract that overwrites owners, threshold, modules, or any other storage |
| **MultiSend nested delegatecall** | A MultiSend batch containing inner DelegateCall sub-transactions that bypass the BB-L-4 slot check |
| **SELFDESTRUCT via delegatecall** | On Quai Network (London EVM), SELFDESTRUCT is still functional. A DelegateCall to a contract containing SELFDESTRUCT would destroy the proxy and drain all funds |
| **Future unknown delegatecall attacks** | Any attack vector we haven't imagined that relies on executing arbitrary code in the wallet's storage context |

### Which Modules Need DelegateCall?

Most modules do **not** need DelegateCall. They interact with the wallet via `Call` — the
wallet calls external functions on targets, which is safe because the target's code runs
in its own storage context.

| Module | Operation Type | Works with DelegateCall Disabled? |
|---|---|---|
| **SocialRecoveryModule** | `Call` only | Yes |
| **Baal (Moloch v3)** | `Call` only | Yes |
| **Zodiac Delay Modifier** | `Call` only | Yes |
| **Zodiac Roles Modifier** | `Call` only | Yes |
| **Zodiac Reality Module** | `Call` only | Yes |
| **Zodiac Bridge Module** | `Call` only | Yes |
| **Any module calling `addOwner`, `removeOwner`, `changeThreshold`** | `Call` (self-call via module) | Yes |
| **MultiSend** (batched transactions) | **DelegateCall required** | **No** |
| **Custom modules with storage manipulation** | **DelegateCall required** | **No** |

**The only common use case that requires DelegateCall is MultiSend batching** — executing
multiple transactions atomically in a single call. MultiSend must run via DelegateCall
because it needs to execute sub-transactions *from* the wallet's address (as `msg.sender`).

### When to Enable DelegateCall

In most cases: **never.** The default `delegatecallDisabled = true` is the correct
posture for wallets holding significant value.

Consider enabling DelegateCall (`setDelegatecallDisabled(false)`) only if:

1. **You need MultiSend batching** — e.g., a module that must execute multiple operations
   atomically (all-or-nothing). Without DelegateCall, the module must make individual
   `Call` operations, which execute independently (no atomicity guarantee across calls).

2. **You have audited the specific module** that requires DelegateCall and understand
   exactly what storage it accesses.

3. **You re-disable DelegateCall after use** — if you only need it for a specific operation,
   enable it, execute, then immediately re-harden with `setDelegatecallDisabled(true)`.

### What You Lose with DelegateCall Disabled

- **MultiSend batching**: Modules must make individual calls instead of batched operations.
  This means multiple transactions instead of one atomic batch. Each call succeeds or
  fails independently.

- **Future modules requiring DelegateCall**: Any module that legitimately needs to run
  code in the wallet's storage context will not work. These are rare — the vast majority
  of module use cases are `Call`-based.

What you **do not lose**:
- All `Call`-based module operations (SocialRecovery, Baal, Zodiac modifiers)
- All multisig operations (propose, approve, execute, cancel)
- Self-calls (addOwner, removeOwner, changeThreshold, enableModule, etc.)
- EIP-1271 message signing and validation
- ETH/token receiving
- Everything except `DelegateCall` through the module execution path

### Defense-in-Depth: DelegateCall + BB-L-4

Even when DelegateCall is enabled (`delegatecallDisabled = false`), QuaiVault still has
the BB-L-4 defense: a pre/post snapshot of the ERC1967 implementation slot around every
DelegateCall. If the delegated code overwrites the implementation slot, the transaction
reverts with `ImplementationSlotTampered`.

This means there are **two layers of defense**:

1. **CR-1 (`delegatecallDisabled`)**: Blocks DelegateCall entirely. Prevents all
   storage-context attacks. Enabled by default.

2. **BB-L-4 (implementation slot check)**: If DelegateCall is allowed, guards the most
   critical single slot (the proxy implementation pointer). Does not protect other storage.

For maximum security, keep CR-1 enabled. BB-L-4 is a fallback for cases where DelegateCall
must be allowed.

---

## Known Limitations (Audit Round 4)

These items were identified during the SA-4 security audit and are documented here for
transparency. None are exploitable — they are design limitations and integration notes.

### EIP-1271 Signing Pattern (SA-4-L-3)

QuaiVault uses a mapping-based EIP-1271 implementation (no ECDSA). To pre-approve a message
hash for external protocol validation:

```
// Correct — abi.encode wraps the bytes32 hash into bytes for signMessage
wallet.signMessage(abi.encode(messageHash))

// Then external protocols call:
wallet.isValidSignature(messageHash, anySig)  // returns magic value
```

The `abi.encode` wrapper is required because `signMessage` accepts `bytes` while
`isValidSignature` receives `bytes32`. This is the **same pattern Gnosis Safe uses** and
is inherent to any mapping-based EIP-1271 implementation.

**If you're integrating QuaiVault with a DeFi protocol**: always use `abi.encode(hash)` when
calling `signMessage`. Calling `signMessage(rawHash)` without the wrapper will store a
different key in `signedMessages` and `isValidSignature` will return failure.

### Proxy Receive Path (SA-4-L-2)

Plain QUAI transfers (no calldata) are handled by the proxy's own `receive()` function and
do **not** DelegateCall to the implementation. This is by design — it solves a Quai Network
access-list issue. Both the proxy and implementation emit identical `Received(sender, value)`
events, so indexers see consistent data.

**What this means for you**: Balance tracking works correctly via `address(wallet).balance`.
If you build custom tooling that tracks deposits by hooking into the implementation's
`receive()`, be aware that plain transfers never reach it.

### Proposer Self-DOS (SA-4-I-3)

A proposer can create transactions that become un-executable — for example, by targeting a
contract that self-destructs or by draining the target's expected balance before the vault
executes. Under Option B failure handling, the external call fails, `TransactionFailed` is
emitted, and the transaction is marked `executed = true`. No vault funds are lost.

**What this means for you**: Other owners waste gas on approvals for a doomed transaction,
but the wallet is never bricked. This is inherent to all multisig systems — there is no
way to guarantee a future transaction will succeed.

### Fallback Accepts ETH with Calldata (SA-4-I-4)

QuaiVault's `fallback()` accepts ETH when `msg.value > 0` regardless of calldata content.
This supports payment routers that attach memo data. When `msg.value == 0` and calldata
doesn't match any function selector, the fallback correctly reverts.

**What this means for you**: No action needed. Solidity dispatches to matching function
selectors before reaching the fallback, so misrouted function calls with ETH attached will
still execute the correct function. Only truly unmatched selectors with ETH reach the
fallback — and accepting ETH in that case is the safe behavior.

### Frontend: getWalletsByCreator Removed (SA-4-I-7)

The factory's `getWalletsByCreator()` function was removed due to O(n^2) gas cost at scale.
The frontend's "My Wallets" feature currently calls this removed function and will revert.

**What this means for you**: If you're using the frontend dashboard, wallet listing will
fail until the frontend is updated to use the indexer for wallet lookups. Your wallets and
funds are unaffected — this is purely a UI issue.

---

## Security Summary

| Threat | Contract mitigates? | Your defense |
|---|---|---|
| Key compromise at threshold | Partially (timelock delays external calls) | Hardware wallets, key distribution, high threshold |
| Buggy/malicious module | Partially (`onlySelf` to enable) | Only enable audited modules, regular review |
| Module DelegateCall storage attack | Yes — blocked by default (CR-1) | Keep `delegatecallDisabled = true` |
| Guardian takeover | Partially (recovery delay period) | Independent guardians, active monitoring, owner key availability |
| Frontend/indexer deception | No | Verify calldata on-chain, multiple independent UIs |
| Social engineering | No | Out-of-band verification, no approvals under pressure |
| Clock gaming | Yes — fully prevented | None needed |
| Ghost approvals | Yes — fully prevented | None needed |
| Nonce/ordering attacks | Yes — fully prevented | None needed |
| Expired tx exploitation | Yes — fully prevented | None needed |
| Reentrancy | Yes — fully prevented | None needed |
| Storage griefing | Yes — fully prevented | None needed |

**The contract protects against everything a contract can protect against.** The remaining
attack surface is humans and infrastructure — key management, module trust, frontend integrity,
and social engineering. These are operational concerns that no smart contract can solve.
This is true for every multisig ever built, including Gnosis Safe.
